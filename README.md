# tauri-plugin-configurate

**Tauri v2 plugin for type-safe application configuration management with OS keyring support.**

Store app settings as JSON, YAML, Binary, or SQLite — with sensitive values automatically secured in the OS keyring (Windows Credential Manager / macOS Keychain / Linux Secret Service).

---

> [!WARNING]
> **Pre-release software (0.x)**
>
> This plugin is under active development and has **not reached a stable 1.0 release**.
>
> - **Breaking changes may be introduced in any minor version** (e.g. 0.2 → 0.3).
> - **Bugs may be present.** Please report issues on [GitHub](https://github.com/Crysta1221/tauri-plugin-configurate/issues).
> - The on-disk format of **`BinaryProvider()` (unencrypted)** changed in v0.2.3 — existing files written by v0.2.2 or earlier must be re-created. Encrypted binary files (`BinaryProvider({ encryptionKey })`) are not affected.
>
> Pin to an exact version in production and review the [release notes](https://github.com/Crysta1221/tauri-plugin-configurate/releases) before upgrading.

---

## Features

| Feature                       | Description                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| 🛡️ **Type-safe schema**       | Define your config shape with `defineConfig()` — TypeScript infers all value types automatically |
| 🔑 **OS keyring integration** | Mark sensitive fields with `keyring()` — secrets never touch disk                                |
| 🧩 **Multiple providers**     | Choose JSON, YAML, Binary (encrypted or plain), or SQLite as the storage backend                 |
| 📄 **Single-file API**        | `create` / `load` / `save` / `delete` / `unlock` — consistent builder-style calls                |
| 📦 **Batch API**              | `loadAll` / `saveAll` — load or save multiple configs in a single IPC round-trip                 |
| 🗂️ **Flexible paths**         | Control the storage location with `baseDir`, `options.dirName`, and `options.currentPath`        |

---

## Installation

### 1. Add the Rust plugin

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-configurate = "0.x.x"
```

Register it in `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_configurate::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**or, use tauri cli.**

```sh
tauri add configurate
```

### 2. Add the JavaScript / TypeScript API

```sh
# npm
npm install tauri-plugin-configurate-api

# pnpm
pnpm add tauri-plugin-configurate-api

# yarn
yarn add tauri-plugin-configurate-api

# bun
bun add tauri-plugin-configurate-api
```

> **Tip:** If you use the Tauri CLI, `tauri add configurate` handles both steps automatically.

### 3. Grant permissions

Add the following to your capability file (e.g. `src-tauri/capabilities/default.json`):

```json
{
  "permissions": ["configurate:default"]
}
```

`configurate:default` expands to:

| Permission                   | Operation                  |
| ---------------------------- | -------------------------- |
| `configurate:allow-create`   | Create a new config file   |
| `configurate:allow-load`     | Read a config file         |
| `configurate:allow-save`     | Write/update a config file |
| `configurate:allow-delete`   | Delete a config file       |
| `configurate:allow-load-all` | Batch load                 |
| `configurate:allow-save-all` | Batch save                 |
| `configurate:allow-unlock`   | Inline keyring decryption  |

---

## Quick Start

### Step 1 — Define your schema

```ts
import { defineConfig, keyring } from "tauri-plugin-configurate-api";

const appSchema = defineConfig({
  theme: String,
  language: String,
  database: {
    host: String,
    // "password" is stored in the OS keyring, never written to disk
    password: keyring(String, { id: "db-password" }),
  },
});
```

`defineConfig()` validates at runtime that all `keyring()` IDs are unique within the schema.

You can also define array schemas with a single element descriptor:

```ts
const schema = defineConfig({
  tags: [String],
  timetable: [
    {
      time: String,
      token: keyring(String, { id: "timetable-token" }),
      xxx: String,
      loc_by: {
        bus: {
          mix: Number,
          min: Number,
        },
        bike: {
          mix: Number,
          min: Number,
        },
      },
    },
  ],
});
```

Array elements with `keyring()` are supported. The plugin stores each element with
an index-aware keyring id under the hood.

### Step 2 — Create a `Configurate` instance

```ts
import { BaseDirectory, Configurate, JsonProvider } from "tauri-plugin-configurate-api";

const config = new Configurate({
  schema: appSchema,
  fileName: "app.json", // filename only, no path separators
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
  options: {
    dirName: "my-app", // replaces the app identifier segment
    currentPath: "config/v2", // sub-directory within the root
  },
});
```

The resolved path is: `{AppConfig}/my-app/config/v2/app.json`

### Step 3 — Read and write

```ts
const KEYRING = { service: "my-app", account: "default" };

// Create — writes plain fields to disk, stores secrets in the OS keyring
await config
  .create({
    theme: "dark",
    language: "ja",
    database: { host: "localhost", password: "secret" },
  })
  .lock(KEYRING) // KEYRING opts are required when the schema has keyring fields
  .run();

// Load (locked) — keyring fields come back as null
const locked = await config.load().run();
console.log(locked.data.database.password); // null

// Load (unlocked) — keyring fields are filled from the OS keyring
const unlocked = await config.load().unlock(KEYRING);
console.log(unlocked.data.database.password); // "secret"

// Save — same pattern as create
await config
  .save({
    theme: "light",
    language: "en",
    database: { host: "db.example.com", password: "next-secret" },
  })
  .lock(KEYRING)
  .run();

// Delete — removes the file and wipes keyring entries
await config.delete(KEYRING);
```

---

## Providers

Choose the storage format when constructing a `Configurate` instance.

```ts
import {
  JsonProvider,
  YmlProvider,
  BinaryProvider,
  SqliteProvider,
} from "tauri-plugin-configurate-api/provider";

// Plain JSON (human-readable)
JsonProvider();

// YAML
YmlProvider();

// Encrypted binary using XChaCha20-Poly1305
// The key is hashed via SHA-256 internally — use a high-entropy string
BinaryProvider({ encryptionKey: "high-entropy-key" });

// Unencrypted binary (compact JSON bytes, no human-readable format)
BinaryProvider();

// SQLite — all schema fields become typed columns
SqliteProvider({ dbName: "app.db", tableName: "configs" });
```

> [!NOTE]
> `BinaryProvider()` without an `encryptionKey` provides **no confidentiality**.
> Use `BinaryProvider({ encryptionKey })` or the OS keyring for sensitive values.

---

## Batch Operations

Load or save multiple configs in a **single IPC call** with `loadAll` / `saveAll`.

```ts
const appConfig = new Configurate({
  schema: defineConfig({ theme: String }),
  fileName: "app.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
});

const secretConfig = new Configurate({
  schema: defineConfig({ token: keyring(String, { id: "api-token" }) }),
  fileName: "secret.bin",
  baseDir: BaseDirectory.AppConfig,
  provider: BinaryProvider({ encryptionKey: "high-entropy-key" }),
});

// Load all — unlock a specific entry by id
const loaded = await Configurate.loadAll([
  { id: "app", config: appConfig },
  { id: "secret", config: secretConfig },
])
  .unlock("secret", { service: "my-app", account: "default" })
  .run();

// Save all — lock a specific entry by id
const saved = await Configurate.saveAll([
  { id: "app", config: appConfig, data: { theme: "dark" } },
  { id: "secret", config: secretConfig, data: { token: "next-token" } },
])
  .lock("secret", { service: "my-app", account: "default" })
  .run();
```

### Result shape

Each entry in `results` is either a success or a per-entry failure — a single entry failing **does not abort the batch**.

```ts
type BatchRunResult = {
  results: {
    [id: string]:
      | { ok: true; data: unknown }
      | { ok: false; error: { kind: string; message: string } };
  };
};

// Access individual results
loaded.results.app; // { ok: true, data: { theme: "dark" } }
loaded.results.secret; // { ok: true, data: { token: "..." } }
```

---

## Path Resolution

| Option                | Effect                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `baseDir`             | Tauri `BaseDirectory` enum value (e.g. `AppConfig`, `AppData`, `Desktop`)                                                |
| `options.dirName`     | Replaces the app-identifier segment when it is the last segment of `baseDir` path; otherwise appended as a sub-directory |
| `options.currentPath` | Sub-directory appended after the `dirName` root                                                                          |
| `fileName`            | Single filename — **must not contain path separators**                                                                   |

Example — `baseDir: AppConfig`, `dirName: "my-app"`, `currentPath: "v2"`, `fileName: "settings.json"`:

```
Windows:  C:\Users\<user>\AppData\Roaming\my-app\v2\settings.json
macOS:    ~/Library/Application Support/my-app/v2/settings.json
Linux:    ~/.config/my-app/v2/settings.json
```

---

## Compatibility

The following **deprecated** forms are still accepted in the current minor version and automatically normalized to the new API. Each emits one `console.warn` per process.

| Deprecated form                 | Replacement                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `new Configurate(schema, opts)` | `new Configurate({ schema, ...opts })`                           |
| `ConfigurateFactory`            | `new Configurate({ ... })`                                       |
| `dir`                           | `baseDir`                                                        |
| `name`                          | `fileName`                                                       |
| `path`                          | `options.currentPath`                                            |
| `format` + `encryptionKey`      | `provider: JsonProvider()` / `BinaryProvider({ encryptionKey })` |

> These compatibility shims will be **removed in the next minor release**.

---

## License

MIT © [Crysta1221](https://github.com/Crysta1221)
