fn main() {
    // tauri-build watches tauri.conf.json, but not the icon files themselves.
    // Without this, regenerating icons/ leaves the dock icon stuck on the old embed.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
