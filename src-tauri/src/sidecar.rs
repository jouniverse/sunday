//! Supervisor for the Python solar-physics sidecar (pvlib).
//!
//! The sidecar is a local HTTP service. Rust owns its lifecycle and hands the
//! frontend a base URL plus a per-launch bearer token; the frontend then talks
//! to it directly with `fetch`, which keeps large time-series payloads off the
//! IPC bridge.
//!
//! The app must remain usable when the sidecar is missing, so every failure here
//! is reported as state, not as a fatal error.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{Error, Result};

const HOST: &str = "127.0.0.1";
/// Fixed port keeps the Vite dev proxy and the packaged app consistent.
pub const DEFAULT_PORT: u16 = 8787;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    /// No attempt made yet.
    Stopped,
    /// Process spawned, health check not yet successful.
    Starting,
    Ready,
    /// Could not start or health check failed; `detail` explains why.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub base_url: String,
    /// Present only once the process is running; the frontend sends it as a
    /// bearer token so nothing else on the machine can drive the engine.
    pub token: Option<String>,
    pub detail: Option<String>,
    /// pvlib version reported by the engine, for provenance in reports.
    pub pvlib_version: Option<String>,
    /// True when the engine was started by an external process (dev workflow).
    pub external: bool,
}

pub struct Sidecar {
    inner: Mutex<Inner>,
}

struct Inner {
    child: Option<Child>,
    status: EngineStatus,
    port: u16,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self::new(DEFAULT_PORT)
    }
}

impl Sidecar {
    pub fn new(port: u16) -> Self {
        Self {
            inner: Mutex::new(Inner {
                child: None,
                port,
                status: EngineStatus {
                    state: EngineState::Stopped,
                    base_url: format!("http://{HOST}:{port}"),
                    token: None,
                    detail: None,
                    pvlib_version: None,
                    external: false,
                },
            }),
        }
    }

    pub fn status(&self) -> EngineStatus {
        let mut inner = self.inner.lock().expect("sidecar mutex");
        let base_url = format!("http://{HOST}:{}", inner.port);
        let token = inner.status.token.clone();

        // `status` used to return a stale Stopped cache forever when the user had
        // already started the engine externally (`npm run engine:dev`). Probe
        // health whenever we are not supervising a live child we know is Ready.
        let should_probe = match inner.status.state {
            EngineState::Ready if inner.child.is_some() => false,
            _ => true,
        };

        if should_probe {
            if let Some(health) = probe(&base_url, token.as_deref()) {
                inner.status = EngineStatus {
                    state: EngineState::Ready,
                    base_url,
                    token,
                    detail: None,
                    pvlib_version: health.pvlib_version,
                    external: inner.child.is_none(),
                };
            } else if inner.status.state == EngineState::Ready && inner.child.is_none() {
                // External engine went away.
                inner.status.state = EngineState::Stopped;
                inner.status.pvlib_version = None;
                inner.status.external = false;
                inner.status.detail = None;
            }
        }

        inner.status.clone()
    }

    /// Starts the sidecar if it is not already reachable.
    ///
    /// An engine already listening on the port (started by `npm run engine:dev`)
    /// is adopted rather than duplicated.
    pub fn ensure_started(&self, command: EngineCommand) -> EngineStatus {
        let mut inner = self.inner.lock().expect("sidecar mutex");

        if inner.status.state == EngineState::Ready && inner.child.is_some() {
            return inner.status.clone();
        }

        let base_url = format!("http://{HOST}:{}", inner.port);

        // Adopt an externally started engine.
        if let Some(health) = probe(&base_url, None) {
            inner.status = EngineStatus {
                state: EngineState::Ready,
                base_url,
                token: None,
                detail: None,
                pvlib_version: health.pvlib_version,
                external: true,
            };
            return inner.status.clone();
        }

        let token = random_token();
        match spawn(&command, inner.port, &token) {
            Ok(child) => {
                inner.child = Some(child);
                inner.status = EngineStatus {
                    state: EngineState::Starting,
                    base_url: base_url.clone(),
                    token: Some(token.clone()),
                    detail: None,
                    pvlib_version: None,
                    external: false,
                };

                // Health-poll briefly: interpreter start plus pvlib import.
                for _ in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    if let Some(health) = probe(&base_url, Some(&token)) {
                        inner.status.state = EngineState::Ready;
                        inner.status.pvlib_version = health.pvlib_version;
                        return inner.status.clone();
                    }
                    if let Some(child) = inner.child.as_mut() {
                        if let Ok(Some(exit)) = child.try_wait() {
                            inner.status.state = EngineState::Unavailable;
                            inner.status.detail = Some(format!(
                                "solar engine exited during start-up with status {exit}; \
                                 check that its Python dependencies are installed"
                            ));
                            inner.child = None;
                            return inner.status.clone();
                        }
                    }
                }
                inner.status.state = EngineState::Unavailable;
                inner.status.detail =
                    Some("solar engine did not answer a health check within 10 s".into());
                inner.status.clone()
            }
            Err(error) => {
                inner.status = EngineStatus {
                    state: EngineState::Unavailable,
                    base_url,
                    token: None,
                    detail: Some(error.to_string()),
                    pvlib_version: None,
                    external: false,
                };
                inner.status.clone()
            }
        }
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().expect("sidecar mutex");
        if let Some(mut child) = inner.child.take() {
            child.kill().ok();
            child.wait().ok();
        }
        inner.status.state = EngineState::Stopped;
        inner.status.token = None;
    }
}

/// How to launch the engine. In development this is the interpreter plus the
/// module; in a packaged app it is the bundled PyInstaller binary.
#[derive(Debug, Clone)]
pub enum EngineCommand {
    /// `python -m uvicorn ...` from a working directory.
    Interpreter { python: String, working_dir: std::path::PathBuf },
    /// A self-contained executable produced at packaging time.
    Bundled { executable: std::path::PathBuf },
}

fn spawn(command: &EngineCommand, port: u16, token: &str) -> Result<Child> {
    let mut process = match command {
        EngineCommand::Interpreter { python, working_dir } => {
            if !working_dir.exists() {
                return Err(Error::EngineUnavailable(format!(
                    "solar engine source directory not found at {}",
                    working_dir.display()
                )));
            }
            let mut cmd = Command::new(python);
            cmd.args([
                "-m",
                "uvicorn",
                "sunday_solar.server:app",
                "--host",
                HOST,
                "--port",
                &port.to_string(),
                "--log-level",
                "warning",
            ]);
            cmd.current_dir(working_dir);
            cmd
        }
        EngineCommand::Bundled { executable } => {
            if !executable.exists() {
                return Err(Error::EngineUnavailable(format!(
                    "bundled solar engine not found at {}",
                    executable.display()
                )));
            }
            let mut cmd = Command::new(executable);
            cmd.args(["--host", HOST, "--port", &port.to_string()]);
            cmd
        }
    };

    process
        .env("SUNDAY_ENGINE_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    process.spawn().map_err(|e| {
        Error::EngineUnavailable(format!("could not start the solar engine: {e}"))
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
struct Health {
    #[serde(default)]
    pvlib_version: Option<String>,
}

fn probe(base_url: &str, token: Option<&str>) -> Option<Health> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .ok()?;
    let mut request = client.get(format!("{base_url}/health"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Health>().ok()
}

fn random_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..32)
        .map(|_| {
            const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
            CHARS[rng.random_range(0..CHARS.len())] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_in_stopped_state_with_a_local_base_url() {
        let sidecar = Sidecar::new(9911);
        let status = sidecar.status();
        assert_eq!(status.state, EngineState::Stopped);
        assert_eq!(status.base_url, "http://127.0.0.1:9911");
        assert!(status.token.is_none());
    }

    #[test]
    fn missing_engine_source_reports_unavailable_rather_than_panicking() {
        let sidecar = Sidecar::new(9912);
        let status = sidecar.ensure_started(EngineCommand::Interpreter {
            python: "python3".into(),
            working_dir: std::path::PathBuf::from("/nonexistent/sunday-engine"),
        });
        assert_eq!(status.state, EngineState::Unavailable);
        assert!(status.detail.unwrap().contains("not found"));
    }

    #[test]
    fn missing_bundled_binary_reports_unavailable() {
        let sidecar = Sidecar::new(9913);
        let status = sidecar.ensure_started(EngineCommand::Bundled {
            executable: std::path::PathBuf::from("/nonexistent/sunday-engine-bin"),
        });
        assert_eq!(status.state, EngineState::Unavailable);
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
