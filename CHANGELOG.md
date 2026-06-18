# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-06-18

# 🚀 0.5.2 Release Notes

Patch release fixing npm TypeScript declarations and a guest-js linter warning.

## 🐛 Fixes

- Emit `dist-js/index.d.ts` and `dist-js/provider.d.ts` during the npm build so `package.json` `types` / `exports` resolve correctly (TypeScript 6 + Rollup previously wrote declarations only under `dist-js/guest-js/`).
- Refactor guest-js path validation to detect NUL bytes without a control-character regex literal, satisfying oxc `no-control-regex`.

## 📦 Install

```toml
tauri-plugin-configurate = "0.5.2"
```

```sh
npm add tauri-plugin-configurate-api@0.5.2
```

## [0.5.1] - 2026-06-11

# 🚀 0.5.1 Release Notes

Security patch for `options.dirName` path resolution.

## ⚠️ Breaking Changes

- `options.dirName` is now always resolved as a **sub-path under** the app-scoped `baseDir` (e.g. `{AppConfig}/my-dir/config.json`). **Before 0.5.1**, when the resolved `baseDir` path ended with the app identifier (e.g. `…/com.example.app`), `dirName` could **replace** that last segment and resolve outside the app sandbox (e.g. `dirName: "Microsoft/Windows/Start Menu/Programs/Startup"` → the system Startup folder). That behavior was removed as a security fix.
- **Migration:** If you relied on the old replacement semantics to reach a folder outside `baseDir`, choose an appropriate `BaseDirectory` (or opt in via `Builder::allow_any_base_directory` on the Rust side) and set `dirName` / `currentPath` as relative segments under that base. To keep configs under the app directory, use a nested name (e.g. `dirName: "autostart"` → `{AppConfig}/autostart/…`, not the OS autostart folder).

## 🔒 Security

- Resolved config paths are checked with canonical path containment after `baseDir` resolution, rejecting symlink escapes outside the app sandbox.
- Guest-js path validation now mirrors Rust `validate_path_component` rules (`...`, Windows-forbidden characters, trailing space/dot).
- `dirName` / `currentPath` segment splitting on Rust now accepts both `/` and `\`, matching the TypeScript side.

## 📦 Install

```toml
tauri-plugin-configurate = "0.5.1"
```

```sh
npm add tauri-plugin-configurate-api@0.5.1
```

## [0.5.0] - 2026-06-10

# 🚀 0.5.0 Release Notes

Major release focused on removing SQLite, hardening security, and adding automated publishing.

## ⚠️ Breaking Changes

- Removed the legacy `SqliteProvider` and all SQLite backend support. Use a file-based provider (`JsonProvider`, `YmlProvider`, `TomlProvider`, or `BinaryProvider`) instead.
- `configurate:allow-unlock` is no longer included in `configurate:default`. Grant `configurate:allow-unlock` explicitly when using `.unlock()` or `loadAll().unlock()`.
- `changeTargetId` now uses a simplified five-field format (`dbName` / `tableName` removed).
- IPC `baseDir` is restricted to app-scoped directories by default (`AppConfig`, `AppData`, etc.). Use `Builder::allowed_base_directories` or `allow_any_base_directory` for `Home`, `Desktop`, and other paths.

## ✨ Features

- Added configurable read size limit via `Builder::max_read_bytes` or `tauri.conf.json` → `plugins.configurate.maxReadBytes` (default: 16 MiB).
- Added `Builder` for plugin initialization; `init()` delegates to `Builder::default()`.
- Added `Builder::allowed_base_directories` and `Builder::allow_any_base_directory` for `BaseDirectory` access control.
- Added tag-triggered release workflow: tests, `cargo publish`, npm Trusted Publishing, and GitHub Release (body from this file).
- README aligned with Tauri community plugin conventions (platform table, badges, configuration).

## 🔒 Security

- `configurate:allow-unlock` is excluded from default permissions; keyring unlock goes only through the `unlock` command — `load` / `load_all` reject `withUnlock` combined with keyring fields.
- Keyring read operations reject entries with a non-empty `value` field; `id` and `dotpath` are validated on the Rust side.
- Dot paths are capped at 64 segments and array indices at 10,000 to prevent memory exhaustion via IPC payloads.
- Batch commands (`load_all`, `save_all`, `patch_all`) accept at most 128 entries per request.
- Config file reads and import content are capped by `maxReadBytes`; `read_file_bounded` opens the file before reading metadata, compares sizes as `u64`, and uses `checked_add` for read limits.
- Binary `encryptionKey` is omitted from IPC payloads for operations that do not read or write encrypted data (including `delete` and `exists`).
- File writes use `tempfile::persist` for atomic replace on Windows (avoids `remove_file` + `rename` TOCTOU).
- `BaseDirectory` allowlist limits config paths to app-scoped directories unless the builder opts out.
- Keyring secrets are always inlined as JSON strings (no implicit JSON parsing).
- `encryption_key` in normalized payloads is held in `Zeroizing<String>`; `configDiff` / `deepEqual` cap nesting depth at 64.

## 📦 Install

```toml
tauri-plugin-configurate = "0.5.0"
```

```sh
npm add tauri-plugin-configurate-api@0.5.0
```

[Unreleased]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.4.2...v0.5.0
