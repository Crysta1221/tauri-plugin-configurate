const COMMANDS: &[&str] = &[
    "create",
    "load",
    "save",
    "patch",
    "delete",
    "exists",
    "load_all",
    "save_all",
    "patch_all",
    "unlock",
    "watch_file",
    "unwatch_file",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
