# Tauri Plugin configurate

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri)](https://v2.tauri.app) [![crates.io](https://img.shields.io/crates/v/tauri-plugin-configurate.svg)](https://crates.io/crates/tauri-plugin-configurate) [![npm](https://img.shields.io/npm/v/tauri-plugin-configurate-api.svg)](https://www.npmjs.com/package/tauri-plugin-configurate-api)

Type-safe application configuration for Tauri v2 with OS keyring support.

Store settings as JSON, YAML, TOML, or Binary. Sensitive fields can be stored in the OS keyring instead of on disk.

| Platform | Supported |
| -------- | --------- |
| Linux    | ✓         |
| Windows  | ✓         |
| macOS    | ✓         |
| Android  | —         |
| iOS      | —         |

_Desktop only. Android and iOS are not supported._

## Install

_This plugin requires a Rust version of at least **1.85.0** (see `rust-toolchain.toml`)_

Install the Rust plugin by adding the following to your `Cargo.toml` file:

`src-tauri/Cargo.toml`

```toml
[dependencies]
tauri-plugin-configurate = "0.6.0"
# alternatively with Git:
# tauri-plugin-configurate = { git = "https://github.com/Crysta1221/tauri-plugin-configurate" }
```

You can install the JavaScript Guest bindings using your preferred JavaScript package manager:

```sh
pnpm add tauri-plugin-configurate-api
# or
npm add tauri-plugin-configurate-api
# or
yarn add tauri-plugin-configurate-api
# or
bun add tauri-plugin-configurate-api
```

Alternatively, run `tauri add configurate` to install both.

## Usage

Register the plugin with Tauri:

`src-tauri/src/lib.rs`

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_configurate::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Grant permissions in your capability file (e.g. `src-tauri/capabilities/default.json`):

```json
{
  "permissions": ["configurate:default"]
}
```

`configurate:default` grants every command except `unlock`, including `delete`, `reset`, `import_config` and `export_config`. Prefer granting only what your app uses, for example `["configurate:allow-load", "configurate:allow-save"]`. The per-command permissions and which API uses which are listed in [commands.md → Permissions](./commands.md#permissions).

When using keyring unlock (`.unlock()`, `loadAll().unlock()`), also add `configurate:allow-unlock`.

Afterwards the plugin APIs are available through the JavaScript guest bindings:

```typescript
import {
  BaseDirectory,
  Configurate,
  JsonProvider,
  defineConfig,
  keyring,
} from "tauri-plugin-configurate-api";

const schema = defineConfig({
  theme: String,
  database: {
    host: String,
    password: keyring(String, { id: "db-password" }),
  },
});

const config = new Configurate({
  schema,
  fileName: "app.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
});

const KEYRING = { service: "my-app", account: "default" };

await config
  .create({
    theme: "dark",
    database: { host: "localhost", password: "secret" },
  })
  .lock(KEYRING)
  .run();

const { data } = await config.load().unlock(KEYRING);
```

See [commands.md](./commands.md) for the full API (batch, patch, export/import, file watching, and more), including:

- `optional()` keys, which may be left out of object literals, and the `json()`, `record()` and `oneOf()` markers for opaque values, string-keyed maps and string enums.
- How `defaults` fill missing keys on load.
- `Configurate.list({ baseDir, provider, options })` to list a directory without a config instance.
- The [error shape](./commands.md#errors) and `isNotFoundError()` to tell a missing file from a broken one.

### Path layout

Configs resolve to `{baseDir}/{dirName?}/{currentPath?}/{fileName}`. `dirName` and `currentPath` are always relative paths **under** the resolved `baseDir`; they cannot escape the app sandbox or replace the app-identifier directory segment (changed in **0.5.1** — see [Breaking Changes](./CHANGELOG.md#051---2026-06-11)). Segment rules, separators (`/` and `\`), and examples are in [commands.md → Path options](./commands.md#path-options).

## Configuration

The maximum size of config files and import content defaults to **16 MiB**. You can change it in Rust or in `tauri.conf.json` (`tauri.conf.json` wins when both are set).

**Rust** (`src-tauri/src/lib.rs`):

```rust
.plugin(
    tauri_plugin_configurate::Builder::default()
        .max_read_bytes(32 * 1024 * 1024)
        .build(),
)
```

**`tauri.conf.json`:**

```json
{
  "plugins": {
    "configurate": {
      "maxReadBytes": 33554432
    }
  }
}
```

### Key order

Files are written with object keys sorted alphabetically. To keep the order of the data you save, enable the `preserve-order` feature:

```toml
[dependencies]
tauri-plugin-configurate = { version = "0.6.0", features = ["preserve-order"] }
```

Cargo unifies features, so this also makes `serde_json::Map` and `toml::map::Map` keep insertion order for the rest of your app's build. See [commands.md → Key order](./commands.md#key-order-preserve-order-feature) for the exact behavior per format.

## Providers

```typescript
JsonProvider();
YmlProvider();
TomlProvider();
BinaryProvider();
BinaryProvider({ encryptionKey: "key" }); // high-entropy key only (SHA-256 KDF)
BinaryProvider({ encryptionKey: "key", kdf: "argon2" }); // password-based
```

Use `kdf: "argon2"` when `encryptionKey` is a user password. The default SHA-256 derivation is for random/high-entropy keys only (no salt, no stretching).

## Security notes

- **Base directories:** By default, IPC payloads may only use app-scoped `BaseDirectory` values (`AppConfig`, `AppData`, `AppLocalData`, `AppCache`, `AppLog`, `Resource`, `Temp`). To allow `Home`, `Desktop`, etc., configure the Rust builder:

```rust
.plugin(
    tauri_plugin_configurate::Builder::default()
        .allowed_base_directories([
            tauri::path::BaseDirectory::AppConfig,
            tauri::path::BaseDirectory::Document,
        ])
        .build(),
)
// Or: .allow_any_base_directory() to disable the restriction
```

- **Encryption key over IPC:** Binary `encryptionKey` is sent over Tauri IPC only when needed (load/create/save/patch). It never crosses the network; restrict devtools in production builds if concerned.
- **YAML imports:** Untrusted YAML can expand via anchors/aliases. Only import config from trusted sources, or prefer JSON/TOML for untrusted input.
- **File writes:** Atomic replace uses `tempfile` (`persist`) including on Windows. External processes writing the same path concurrently are still outside the plugin's advisory lock scope.

## License

MIT © [Crysta1221](https://github.com/Crysta1221)
