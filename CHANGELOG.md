# Changelog

All notable changes to `tauri-plugin-configurate` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Breaking Changes (minor version bump)
- **Removed legacy constructor overload** `Configurate(schema, legacyOpts)`. Use `new Configurate({ schema, ... })`.
- **Removed `LegacyConfigurateOptions` interface** and the `name`/`dir`/`format`/`encryptionKey`/`dirName`/`path` top-level fields from `ConfigurateInit`. Use `fileName`, `baseDir`, `provider`, and `options.{dirName,currentPath}`.
- **Removed `ConfigurateFactory` class**, `ConfigurateFactoryBaseOptions`, and `BuildConfig` interfaces. Construct `Configurate` instances directly.
- **Removed `YamlProvider()`**. Use `YmlProvider()`.
- **Removed `StorageFormat` type** (`"json" | "yaml" | "yml" | "binary"`). Use provider factory functions.
- **Rust**: Removed `StorageFormat` enum. Removed legacy fields (`name`, `dir`, `dir_name`, `path`, `format`, `encryption_key`) from `ConfiguratePayload`. The payload now requires `provider` to be present; the old `format`-only path is gone.

### Added
- `patch().createIfMissing()` — chain this on a `LazyPatchEntry` to create the
  config with the patched data if it does not yet exist, instead of throwing.
- `NormalizedProvider` now redacts `encryption_key` in its `Debug` output so
  keys never appear in log output or panic messages.
- `zeroize` dependency: derived cipher keys (`BinaryEncryptedBackend`) and raw
  passwords (`BinaryArgon2Backend`) are now zeroed from memory on drop.
- `[profile.release]` in `Cargo.toml`: LTO, single codegen unit, `opt-level =
  "s"`, and `strip = true` for smaller release binaries.
- `TomlProvider()` JSDoc: documents the null-field omission behaviour.
- `patch()` JSDoc: documents JSON Merge Patch null semantics (RFC 7396) and the
  new `createIfMissing()` builder method.
- `MigrationStep` is now exported directly from `schema.ts`, eliminating a
  three-hop circular `import type` chain through `index.ts → configurate.ts`.

### Changed
- `patch()` now returns a clear `invalid_payload` error (including the config
  file name and a hint to use `.createIfMissing()`) when the target config does
  not exist, instead of the previous opaque IO `not_found` error.
- `_savePlain` (migration auto-save) now logs a `console.warn` instead of
  silently swallowing errors when the post-migration write fails.
- `watchExternal` payload is built via the new `_buildLocationPayload()` helper
  rather than reusing the `"exists"` operation payload.
- SQLite connections now apply `PRAGMA synchronous=NORMAL` alongside
  `journal_mode=WAL` via the shared `open_sqlite_conn` helper.
- Backup files now use a rotating three-slot scheme (`.bak1` / `.bak2` /
  `.bak3`) rather than always overwriting a single `.bak` file.
- `delete()` partial-failure error message now explicitly states that the
  storage file was deleted and that remaining keyring entries are harmless.
- `separateSecrets` discards the intermediate clone and returns the original
  object when no keyring values are present in the data.
- Serialised `Error` now includes an `io_kind` field (`"not_found"`,
  `"permission_denied"`, etc.) for `Error::Io` variants.
- Removed the broken `/provider` subpath export from `package.json`.

---

## [0.3.1] — 2025-05-xx

### Added
- `patch` command and `Configurate.patch()` API for deep-merge partial updates.
- `patchAll` batch API.
- `onChange(callback)` — subscribes to `configurate://change` events for a
  specific config file.
- `watchExternal` / `unwatchExternal` — file-system watcher for changes from
  external processes.
- Argon2id KDF support for the Binary provider (`BinaryProvider({ kdf: "argon2" })`).
- Schema versioning and migration pipeline (`version`, `migrations`, `defaults`
  options on `Configurate`).
- `optional()` schema field wrapper.
- `assertPartialDataMatchesSchema` for patch validation.

### Changed
- `create_backup` now writes an atomic `.bak` sibling file.
- SQLite writes use `PRAGMA journal_mode=WAL`.

---

## [0.3.0] — 2025-04-xx

### Added
- SQLite provider (`SqliteProvider`).
- `schema_columns` derived from `defineConfig` for structured SQLite storage.
- Per-file in-process mutex (`FileLockRegistry`) to prevent concurrent writes.
- `save_all` / `load_all` batch commands.

### Changed
- Payload normalization moved to `ConfiguratePayload::normalize()`.
- `BinaryProvider` replaces legacy `format: "binary"` option.

---

## [0.2.x]

Initial public releases. JSON, YAML, and encrypted Binary providers.
Keyring integration via `keyring()` schema fields.
