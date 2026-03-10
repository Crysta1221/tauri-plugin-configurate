const COMMANDS: &[&str] = &[
    "create", "load", "save", "delete", "load_all", "save_all", "unlock",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
