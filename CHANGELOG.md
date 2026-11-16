# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-11-16

# 🚀 0.6.0 Release Notes

Feature and dependency update release adding `json()`, `record()`, `oneOf()`, static `Configurate.list()`, `isNotFoundError()`, `preserve-order`, batch splitting over 128 entries, and `tsdown` builds.

## ⚠️ Breaking Changes

- Type-level only: `optional()` fields are now optional keys in `InferLocked` / `InferUnlocked`. Code that annotates such a key as required (`{ x: T | undefined }`) and assigns an inferred config type to it no longer compiles; make the key optional (`x?: T`). Runtime behavior and stored files are unchanged.

## ✨ Features

- The npm package is now built with tsdown instead of `tsc` plus Rollup. Runtime exports are unchanged. Declarations are bundled per entry (`index.d.ts`, `provider.d.ts`; the internal `configurate.d.ts`, `schema.d.ts` and `schema-utils.d.ts` are no longer emitted), and `exports` now gives CommonJS consumers their own `.d.cts` declarations.
- `optional()` fields are now inferred as optional keys (`key?: T | undefined`) in `InferLocked` / `InferUnlocked` at every depth, so object literals for `create()`, `save()`, `defaults` and so on may omit them.
- Added schema markers `json<T>()` (opaque JSON value), `record(schema)` (string-keyed map) and `oneOf("a", "b", ...)` (string literal union). They work with `optional()`, as array elements, with `patch()` and `defaults` (which fill `json()` / `record()` only as a whole), and are validated by `validateOnWrite` / `validateOnRead`. Keyring fields inside `record()` are rejected by `defineConfig()`.
- Added static `Configurate.list({ baseDir, provider, options })` to list config files in a directory without a `Configurate` instance. It uses the existing `list_configs` command, which now accepts a payload without `fileName`, so it needs the 0.6.0 Rust crate: crate 0.5.2 rejects the call with `missing fileName`.
- Exported `isNotFoundError()` and the `ConfigurateError`, `ConfigurateErrorKind` and `ConfigurateIoErrorKind` types. `BatchRunEntryResult` errors are now typed as `ConfigurateError` (`kind` is a union of the known kinds that still accepts any string).
- `Configurate.loadAll()` / `saveAll()` / `patchAll()` accept more than 128 entries: the guest splits the list into consecutive calls of at most 128 entries (the per-call limit in Rust is unchanged) and merges the results. When a split batch has a failed call, its ids are reported as failed entries (kind `batch_call_failed` unless the error is structured) instead of discarding the other calls' results.
- Added the opt-in `preserve-order` Cargo feature to write object keys in insertion order instead of alphabetically.
- Documented the per-command `configurate:allow-*` permissions, `defaults` merge rules, the error shape, and that `save()` creates missing parent directories and `delete()` succeeds when the file is absent.
- Updated `toml` to 1.x. Existing TOML files are read unchanged; a file rewritten by this version may be laid out differently (arrays of tables after tables, fewer escapes in multi-line strings).

## 🐛 Fixes

- `create()` / `save()` / `reset()` with `.run()` no longer ask Rust to send the written data back over IPC; the returned `LockedConfig` was already built from the data passed in.
- Fixed `keyring(String | Number | Boolean, ...)` inferring boxed wrapper types instead of primitives, added compile-time duplicate keyring ID checking inside schema arrays (`CollectKeyringIds`), and fixed `Configurate.reset()`'s return type to `LazyResetEntry<S>`.
- Fixed stale keyring entry deletion when saving/resetting configs with no active keyring writes, returning written keyring values from `.unlock()` on `create()` / `save()` / `reset()` / `patch()`, validating keyring payloads before deleting files in `execute_delete`, and skipping `undefined`/`null` optional keyring writes instead of storing `"null"`.
- Tightened `isPlainObject`, schema array validation, `assertPartialSchemaObject`, `deepMergeDefaults` cloning, `isBinaryProvider` KDF validation, and split-batch error merging when preflight failures reduce a batch to 128 or fewer entries; exported `Configurate` and `ConfigChangeEvent` from the Rust crate root.

## 📦 Install

```toml
tauri-plugin-configurate = "0.6.0"
```

```sh
npm add tauri-plugin-configurate-api@0.6.0
```

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

[Unreleased]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.4.2...v0.5.0
