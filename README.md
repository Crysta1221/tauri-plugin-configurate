# tauri-plugin-configurate

**Tauri v2 plugin for type-safe application configuration management with OS keyring support.**

Store app settings as JSON, YAML, TOML, Binary, or SQLite — with sensitive values automatically secured in the OS keyring (Windows Credential Manager / macOS Keychain / Linux Secret Service).

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

| Feature | Description |
| --- | --- |
| 🛡️ **Type-safe schema** | Define your config shape with `defineConfig()` — TypeScript infers all value types automatically |
| 🔑 **OS keyring integration** | Mark sensitive fields with `keyring()` — secrets never touch disk |
| 🧩 **Multiple providers** | Choose JSON, YAML, TOML, Binary (encrypted or plain), or SQLite as the storage backend |
| 📄 **Single-file API** | `create` / `load` / `save` / `patch` / `delete` / `exists` / `reset` — consistent builder-style calls |
| 📦 **Batch API** | `loadAll` / `saveAll` / `patchAll` — load, save, or patch multiple configs in a single IPC round-trip |
| 🗂️ **Flexible paths** | Control the storage location with `baseDir`, `options.dirName`, and `options.currentPath` |
| 👁️ **File watching** | `watchExternal` / `onChange` — react to changes from external processes or in-app operations |
| 📤 **Export / Import** | `exportAs` / `importFrom` — convert configs between JSON, YAML, and TOML formats |
| 🔄 **Config Diff** | `configDiff()` — compute structural differences between two config objects |
| ✅ **Dry-run validation** | `validate()` / `validatePartial()` — check data against schema without writing to storage |
| 💾 **Rolling backups** | `backup: true` — keep up to 3 backup copies before each write, auto-deleted on app exit |

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
# npm
npm tauri add configurate

# pnpm
pnpm tauri add configurate

# yarn
yarn tauri add configurate

# bun
bun tauri add configurate
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

| Permission | Operation |
| --- | --- |
| `configurate:allow-create` | Create a new config file |
| `configurate:allow-load` | Read a config file |
| `configurate:allow-save` | Write/update a config file |
| `configurate:allow-patch` | Partially update a config file |
| `configurate:allow-delete` | Delete a config file |
| `configurate:allow-exists` | Check if a config exists |
| `configurate:allow-load-all` | Batch load |
| `configurate:allow-save-all` | Batch save |
| `configurate:allow-patch-all` | Batch patch |
| `configurate:allow-unlock` | Inline keyring decryption |
| `configurate:allow-watch-file` | Watch a config file for external changes |
| `configurate:allow-unwatch-file` | Stop watching a config file |
| `configurate:allow-list-configs` | List config files in the storage directory |
| `configurate:allow-reset` | Reset a config to default values |
| `configurate:allow-export-config` | Export config data to a string |
| `configurate:allow-import-config` | Import config data from a string |

---

## Quick Start

### Step 1 — Define your schema

```ts
import { defineConfig, keyring, optional } from "tauri-plugin-configurate-api";

const appSchema = defineConfig({
  theme: String,
  language: String,
  fontSize: optional(Number),
  database: {
    host: String,
    // "password" is stored in the OS keyring, never written to disk
    password: keyring(String, { id: "db-password" }),
  },
});
```

`defineConfig()` validates at runtime that all `keyring()` IDs are unique within the schema.

Array schemas are also supported:

```ts
const schema = defineConfig({
  tags: [String],
  timetable: [
    {
      time: String,
      token: keyring(String, { id: "timetable-token" }),
    },
  ],
});
```

### Step 2 — Create a `Configurate` instance

```ts
import {
  BaseDirectory,
  Configurate,
  JsonProvider,
} from "tauri-plugin-configurate-api";

const config = new Configurate({
  schema: appSchema,
  fileName: "app.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
  options: {
    dirName: "my-app",
    currentPath: "config/v2",
  },
});
```

The resolved path is: `{AppConfig}/my-app/config/v2/app.json`

### Step 3 — Read and write

```ts
const KEYRING = { service: "my-app", account: "default" };

// Create
await config
  .create({
    theme: "dark",
    language: "ja",
    database: { host: "localhost", password: "secret" },
  })
  .lock(KEYRING)
  .run();

// Load (locked) — keyring fields come back as null
const locked = await config.load().run();
console.log(locked.data.database.password); // null

// Load (unlocked) — keyring fields are filled from the OS keyring
const unlocked = await config.load().unlock(KEYRING);
console.log(unlocked.data.database.password); // "secret"

// Save
await config
  .save({
    theme: "light",
    language: "en",
    database: { host: "db.example.com", password: "next-secret" },
  })
  .lock(KEYRING)
  .run();

// Patch — partially update without replacing the full config
await config.patch({ theme: "dark" }).run();

// Exists
const present = await config.exists();

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
  TomlProvider,
  BinaryProvider,
  SqliteProvider,
} from "tauri-plugin-configurate-api";

JsonProvider(); // Plain JSON
YmlProvider(); // YAML
TomlProvider(); // TOML
BinaryProvider({ encryptionKey: "key" }); // Encrypted binary (XChaCha20-Poly1305)
BinaryProvider({ encryptionKey: "key", kdf: "argon2" }); // Encrypted binary with Argon2id KDF
BinaryProvider(); // Unencrypted binary
SqliteProvider({ dbName: "app.db", tableName: "configs" }); // SQLite
```

> [!NOTE]
> `BinaryProvider()` without an `encryptionKey` provides **no confidentiality**. Use `BinaryProvider({ encryptionKey })` or the OS keyring for sensitive values.

---

## Rolling Backups

Enable rolling backups by passing `backup: true` to `Configurate`. Before each write, the previous file is copied to `.bak1` (and older backups are rotated). All backup files are **automatically deleted when the application exits**.

```ts
const config = new Configurate({
  schema: appSchema,
  fileName: "app.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
  backup: true, // opt-in — default is false
});
```

Up to 3 backup slots are kept per file:

| File | Contents |
| --- | --- |
| `app.json.bak1` | Most recent backup (before last write) |
| `app.json.bak2` | Two writes ago |
| `app.json.bak3` | Three writes ago |

> [!NOTE]
> Backups apply only to file-based providers (JSON, YAML, TOML, Binary). SQLite handles durability internally via WAL mode and is unaffected by this option.

---

## Batch Operations

Load, save, or patch multiple configs in a **single IPC call**.

```ts
const loaded = await Configurate.loadAll([
  { id: "app", config: appConfig },
  { id: "secret", config: secretConfig },
])
  .unlock("secret", { service: "my-app", account: "default" })
  .run();

const saved = await Configurate.saveAll([
  { id: "app", config: appConfig, data: { theme: "dark" } },
  { id: "secret", config: secretConfig, data: { token: "next-token" } },
])
  .lock("secret", { service: "my-app", account: "default" })
  .run();

const patched = await Configurate.patchAll([
  { id: "app", config: appConfig, data: { theme: "light" } },
]).run();
```

Each entry in `results` is either a success or a per-entry failure — a single entry failing **does not abort the batch**.

---

## File Watching

### External changes (from other processes)

```ts
const stopWatching = await config.watchExternal((event) => {
  console.log(`File changed externally: ${event.fileName}`);
});

// Later, stop watching
await stopWatching();
```

### In-app changes

```ts
const unlisten = await config.onChange((event) => {
  console.log(`Config ${event.operation}: ${event.fileName}`);
});

// Later, stop listening
unlisten();
```

---

## Additional Features

### List configs

```ts
const files = await config.list();
// ["app.json", "user.json", ...]
```

### Reset to defaults

```ts
await config
  .reset({
    theme: "dark",
    language: "en",
    database: { host: "localhost", password: "secret" },
  })
  .lock(KEYRING)
  .run();
```

### Export / Import

```ts
// Export to YAML string
const yamlString = await config.exportAs("yml");

// Import from TOML string
await config.importFrom(tomlString, "toml", KEYRING);
```

For schemas with `keyring()` fields, pass `KEYRING` to `exportAs()` if you want
the exported string to include decrypted secret values, and pass it to
`importFrom()` so imported secrets are stored back into the OS keyring instead
of being written to disk.

### Dry-run validation

```ts
try {
  config.validate(data); // full validation
  config.validatePartial(patch); // partial validation
} catch (e) {
  console.error("Validation failed:", e.message);
}
```

### Config diff

```ts
import { configDiff } from "tauri-plugin-configurate-api";

const changes = configDiff(
  { theme: "light", fontSize: 14 },
  { theme: "dark", fontSize: 14, lang: "en" },
);
// [
//   { path: "theme", type: "changed", oldValue: "light", newValue: "dark" },
//   { path: "lang", type: "added", newValue: "en" },
// ]
```

---

## Path Resolution

| Option | Effect |
| --- | --- |
| `baseDir` | Tauri `BaseDirectory` enum value (e.g. `AppConfig`, `AppData`, `Desktop`) |
| `options.dirName` | Replaces the app-identifier segment when it is the last segment of `baseDir` path; otherwise appended as a sub-directory |
| `options.currentPath` | Sub-directory appended after the `dirName` root |
| `fileName` | Single filename — **must not contain path separators** |

Example — `baseDir: AppConfig`, `dirName: "my-app"`, `currentPath: "v2"`, `fileName: "settings.json"`:

```
Windows:  C:\Users\<user>\AppData\Roaming\my-app\v2\settings.json
macOS:    ~/Library/Application Support/my-app/v2/settings.json
Linux:    ~/.config/my-app/v2/settings.json
```

---

## API Reference

See [commands.md](./commands.md) for the complete TypeScript API reference.

---

## License

MIT © [Crysta1221](https://github.com/Crysta1221)
