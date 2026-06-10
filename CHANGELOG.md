# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-10

# 🚀 0.5.0 Release Notes

Major release focused on removing SQLite, hardening security, and adding automated publishing.

## ⚠️ Breaking Changes

- Removed the legacy `SqliteProvider` and all SQLite backend support. Use a file-based provider (`JsonProvider`, `YmlProvider`, `TomlProvider`, or `BinaryProvider`) instead.
- `configurate:allow-unlock` is no longer included in `configurate:default`. Grant `configurate:allow-unlock` explicitly when using `.unlock()` or `loadAll().unlock()`.
- `changeTargetId` now uses a simplified five-field format (`dbName` / `tableName` removed).

## ✨ Features

- Added configurable read size limit via `Builder::max_read_bytes` or `tauri.conf.json` → `plugins.configurate.maxReadBytes` (default: 16 MiB).
- Added `Builder` for plugin initialization; `init()` delegates to `Builder::default()`.
- Added tag-triggered release workflow: tests, `cargo publish`, npm Trusted Publishing, and GitHub Release (body from this file).
- README aligned with Tauri community plugin conventions (platform table, badges, configuration).

## 🔒 Security

- Keyring read operations reject entries with a non-empty `value` field; `id` and `dotpath` are validated on the Rust side.
- Config file reads and import content are capped by `maxReadBytes`.
- Binary `encryptionKey` is omitted from IPC payloads when the operation does not read or write encrypted data.

## 📦 Install

```toml
tauri-plugin-configurate = "0.5.0"
```

```sh
npm add tauri-plugin-configurate-api@0.5.0
```

[Unreleased]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Crysta1221/tauri-plugin-configurate/compare/v0.4.2...v0.5.0
