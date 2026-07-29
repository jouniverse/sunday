# Sunday solar engine

The PV physics sidecar. It exists because `pvlib` is the peer-reviewed
implementation of the models Sunday needs (solar position, transposition, cell
temperature, array yield, tracking) and reimplementing them in Rust or
TypeScript would be a downgrade dressed up as an optimisation.

It is a plain local HTTP service. Rust supervises it and the frontend calls it
directly, so time series never cross the Tauri IPC bridge.

## Run it in development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r src-python/requirements.txt
npm run engine:dev            # uvicorn on 127.0.0.1:8787
```

The Vite dev server proxies `/solar-engine` to that port, and the Tauri build
adopts an already-running engine instead of starting a second one.

## Authentication

When Rust starts the engine it passes `SUNDAY_ENGINE_TOKEN`, and every request
must then carry `Authorization: Bearer <token>`. Started by hand without the
variable, the engine accepts unauthenticated local requests — convenient for
development, and it still only listens on the loopback interface.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness plus the `pvlib` version, which reports go on to cite. |
| `POST /sun-path` | Solar position over a day or a year for the sun-path widget. |
| `POST /optimal-tilt` | Tilt/azimuth search maximising annual plane-of-array irradiance. |
| `POST /model-chain` | Monthly and annual energy from a `pvlib` `ModelChain` run. |
| `POST /transpose` | Plane-of-array irradiance for supplied GHI/DNI/DHI. |
| `POST /degradation` | Year-on-year degradation rate from a measured series. |

Every response includes a `method` block naming the models used, so a number in
the UI can always be traced back to the physics that produced it.

## Tests

```bash
python3 -m pytest src-python
```
