const COMMANDS: &[&str] = &["create", "load", "save", "delete", "unlock"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
