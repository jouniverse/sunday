// Keep the Windows console hidden in release builds; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sunday_lib::run();
}
