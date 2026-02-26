# tauri-plugin-configurate

A Tauri v2 plugin for type-safe application configuration management.

Define your config schema once in TypeScript and get full type inference for reads and writes. Supports JSON, YAML, and encrypted binary formats, with first-class OS keyring integration for storing secrets securely off disk.

## Features

- 🛡️ **Type-safe schema** — define your config shape with `defineConfig()` and get compile-time checked reads/writes
- 🔑 **OS keyring support** — mark fields with `keyring()` to store secrets in the native credential store (Keychain / Credential Manager / libsecret) and keep them off disk
- 💾 **Multiple formats** — JSON (human-readable), YAML (human-readable), binary (compact), or encrypted binary (XChaCha20-Poly1305)
- ⚡ **Minimal IPC** — every operation (file read + keyring fetch) is batched into a single IPC round-trip
- 🗂️ **Multiple config files** — use `ConfigurateFactory` to manage multiple files with different schemas from one place
- 🛤️ **Flexible path control** — `dirName` to replace the app identifier, `path` to add sub-directories, custom extensions via the `name` field
- 🚧 **Path traversal protection** — `..`, bare `.`, empty segments, and Windows-forbidden characters (`/ \ : * ? " < > |` and null bytes) are rejected with an `invalid payload` error

## Installation

### Rust

Add the plugin to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-configurate = "0.1.0"
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

### JavaScript / TypeScript

Install the guest bindings:

```sh
# npm
npm install tauri-plugin-configurate-api

# pnpm
pnpm add tauri-plugin-configurate-api

# bun
bun add tauri-plugin-configurate-api
```

### Capabilities (permissions)

Add the following to your capability file (e.g. `src-tauri/capabilities/default.json`):

```json
{
  "permissions": ["configurate:default"]
}
```

`configurate:default` grants access to all plugin commands. You can also allow them individually:

| Permission                 | Description                                |
| -------------------------- | ------------------------------------------ |
| `configurate:allow-create` | Allow creating a new config file           |
| `configurate:allow-load`   | Allow loading a config file                |
| `configurate:allow-save`   | Allow saving (overwriting) a config file   |
| `configurate:allow-delete` | Allow deleting a config file               |
| `configurate:allow-unlock` | Allow fetching secrets from the OS keyring |

## Usage

### 1. Define a schema

Use `defineConfig()` to declare the shape of your config. Primitive fields use constructor values (`String`, `Number`, `Boolean`). Nested objects are supported. Fields that should be stored in the OS keyring are wrapped with `keyring()`.

```ts
import {
  defineConfig,
  keyring,
  ConfigurateFactory,
  BaseDirectory,
} from "tauri-plugin-configurate-api";

const appSchema = defineConfig({
  theme: String,
  language: String,
  fontSize: Number,
  notifications: Boolean,
  database: {
    host: String,
    port: Number,
    // stored in the OS keyring — never written to disk
    password: keyring(String, { id: "db-password" }),
  },
});
```

`keyring()` IDs must be unique within a schema. Duplicates are caught at both compile time and runtime.

### 2. Create a factory

`ConfigurateFactory` holds shared options (`dir`, `format`, optional `dirName`, optional `path`, optional `encryptionKey`) and produces `Configurate` instances — one per config file.

```ts
const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "json",
  // dirName: "my-app",   // replaces the identifier: %APPDATA%/my-app/
  // path: "config",      // sub-directory within the root: <root>/config/
  // encryptionKey: key,  // enables encrypted binary (.binc), requires format: "binary"
});
```

### 3. Build a `Configurate` instance

`factory.build()` accepts either a plain filename string or an object for full control.

```ts
// Plain string — filename as-is (include extension)
const appConfig = factory.build(appSchema, "app.json");

// Object form — sub-directory within the root
const nestedConfig = factory.build(appSchema, { name: "app.json", path: "config/v2" });

// Object form — replace the app identifier directory
const movedConfig = factory.build(appSchema, { name: "app.json", dirName: "my-app" });

// Object form — both dirName and path
const fullConfig = factory.build(appSchema, { name: "app.json", dirName: "my-app", path: "config" });

// Third-argument shorthand — overrides factory-level dirName (string form only)
const specialConfig = factory.build(specialSchema, "special.json", "other-dir");
```

#### Path layout

With `BaseDirectory.AppConfig` on Windows (identifier `com.example.app`):

| `name`      | `dirName`   | `path`      | Resolved path                                       |
| ----------- | ----------- | ----------- | --------------------------------------------------- |
| `app.json`  | _(omitted)_ | _(omitted)_ | `%APPDATA%\com.example.app\app.json`                |
| `app.json`  | `my-app`    | _(omitted)_ | `%APPDATA%\my-app\app.json`                         |
| `app.json`  | _(omitted)_ | `cfg/v2`    | `%APPDATA%\com.example.app\cfg\v2\app.json`         |
| `app.json`  | `my-app`    | `cfg/v2`    | `%APPDATA%\my-app\cfg\v2\app.json`                  |
| `.env`      | _(omitted)_ | _(omitted)_ | `%APPDATA%\com.example.app\.env`                   |
| `data.yaml` | `my-app`    | `profiles`  | `%APPDATA%\my-app\profiles\data.yaml`              |

> **`name`** — full filename including extension (e.g. `"app.json"`, `"data.yaml"`, `".env"`). Must be a single component — path separators are rejected. No extension is appended automatically.
>
> **`dirName`** — replaces the identifier component of the base path (`com.example.app` → your value). For base directories without an identifier (e.g. `Desktop`, `Home`), `dirName` is appended as a sub-directory instead. Each segment is validated; `..` and Windows-forbidden characters are rejected.
>
> **`path`** — adds a sub-directory within the root (after `dirName` / identifier). Use forward slashes for nesting (e.g. `"profiles/v2"`). Each segment is validated the same way.

Each call to `build()` can use a different schema, `name`, `dirName`, and/or `path`.

### 4. Create, load, save, delete

All file operations return a `LazyConfigEntry` that you execute with `.run()` or `.unlock()`.

#### Create

```ts
await appConfig
  .create({
    theme: "dark",
    language: "en",
    fontSize: 14,
    notifications: true,
    database: { host: "localhost", port: 5432, password: "s3cr3t" },
  })
  .lock({ service: "my-app", account: "default" }) // write password to keyring
  .run();
```

#### Load (secrets remain `null`)

```ts
const locked = await appConfig.load().run();

locked.data.theme; // "dark"
locked.data.database.password; // null  ← secret is not in memory
```

#### Load and unlock in one IPC call

```ts
const unlocked = await appConfig.load().unlock({ service: "my-app", account: "default" });

unlocked.data.database.password; // "s3cr3t"
```

#### Unlock a `LockedConfig` later (no file re-read)

```ts
const locked = await appConfig.load().run();
// ... pass locked.data to the UI without secrets ...
const unlocked = await locked.unlock({ service: "my-app", account: "default" });
```

`locked.unlock()` issues a single IPC call that reads only from the OS keyring — the file is not read again.

#### Save

```ts
await appConfig
  .save({
    theme: "light",
    language: "ja",
    fontSize: 16,
    notifications: false,
    database: { host: "db.example.com", port: 5432, password: "newpass" },
  })
  .lock({ service: "my-app", account: "default" })
  .run();
```

#### Delete

```ts
// Pass keyring options to wipe secrets from the OS keyring as well.
await appConfig.delete({ service: "my-app", account: "default" });

// Omit keyring options when the schema has no keyring fields.
await appConfig.delete();
```

---

## Multiple config files

Use `ConfigurateFactory` to manage several config files — each can have a different schema, name, or format.

```ts
const appSchema = defineConfig({ theme: String, language: String });
const cacheSchema = defineConfig({ lastSync: Number });
const secretSchema = defineConfig({
  token: keyring(String, { id: "api-token" }),
});

const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "json",
  dirName: "my-app", // → %APPDATA%/my-app/ (replaces identifier)
});

const appConfig    = factory.build(appSchema,    "app.json");    // → %APPDATA%/my-app/app.json
const cacheConfig  = factory.build(cacheSchema,  "cache.json");  // → %APPDATA%/my-app/cache.json
const secretConfig = factory.build(secretSchema, "secrets.json"); // → %APPDATA%/my-app/secrets.json

// Object form — sub-directory within the root
const v2Config   = factory.build(appSchema,   { name: "app.json",   path: "v2" });           // → %APPDATA%/my-app/v2/app.json
const deepConfig = factory.build(cacheSchema, { name: "cache.json", path: "archive/2025" }); // → %APPDATA%/my-app/archive/2025/cache.json

// Object form — override dirName per instance
const otherConfig = factory.build(appSchema, { name: "app.json", dirName: "other-app" }); // → %APPDATA%/other-app/app.json

// Third-argument shorthand (string form only)
const legacyConfig = factory.build(legacySchema, "legacy.json", "old-app"); // → %APPDATA%/old-app/legacy.json

// Each instance is a full Configurate — all operations are available
const app = await appConfig.load().run();
const cache = await cacheConfig.load().run();
```

## Encrypted binary format

Set `format: "binary"` and provide an `encryptionKey` to store config files encrypted with **XChaCha20-Poly1305**. The 32-byte cipher key is derived internally via SHA-256, so any high-entropy string is suitable — a random key stored in the OS keyring is ideal.

Encrypted files use the **`.binc`** extension (plain binary files use `.bin`). Since `name` is the full filename, you must specify the correct extension yourself (e.g. `"app.binc"` for encrypted, `"app.bin"` for plain binary, `"app.json"` for JSON, `"app.yaml"` for YAML). No extension is appended automatically — a mismatch between `format` and the file extension will not be caught at construction time. Never mix backends: opening a `.binc` file with the wrong or missing key returns an error; opening a plain `.bin` file with an `encryptionKey` also returns a decryption error.

```ts
const encKey = await getEncryptionKeyFromKeyring(); // your own retrieval logic

const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "binary",
  encryptionKey: encKey,
});

const config = factory.build(appSchema, "app.binc"); // encrypted binary

await config.create({ theme: "dark", language: "en" /* ... */ }).run();
const locked = await config.load().run();
```

On-disk format: `[24-byte random nonce][ciphertext + 16-byte Poly1305 tag]`.

> **Note** — `encryptionKey` is only valid with `format: "binary"`. Providing it with `"json"` or `"yaml"` throws an error at construction time.

## API reference

### `defineConfig(schema)`

Validates the schema for duplicate keyring IDs and returns it typed as `S`. Throws at runtime if a duplicate ID is found.

```ts
const schema = defineConfig({ name: String, port: Number });
```

### `keyring(type, { id })`

Marks a schema field as keyring-protected. The field is stored in the OS keyring and appears as `null` in the on-disk file and in `LockedConfig.data`.

```ts
keyring(String, { id: "my-secret" });
```

### `ConfigurateFactory`

```ts
new ConfigurateFactory(baseOpts: ConfigurateBaseOptions)
```

`ConfigurateBaseOptions` is `ConfigurateOptions` without `name`:

| Field           | Type            | Description                                                          |
| --------------- | --------------- | -------------------------------------------------------------------- |
| `dir`           | `BaseDirectory` | Base directory for all files                                         |
| `dirName`       | `string?`       | Replaces the app identifier component of the base path               |
| `path`          | `string?`       | Sub-directory within the root (after `dirName` / identifier)         |
| `format`        | `StorageFormat` | `"json"`, `"yaml"`, or `"binary"`                                    |
| `encryptionKey` | `string?`       | Encryption key (binary format only)                                  |

#### `factory.build(schema, name, dirName?)` / `factory.build(schema, config)`

Returns a `Configurate<S>` for the given schema. The second argument is either:
- a plain `string` — the full filename including extension (e.g. `"app.json"`, `".env"`)
- `{ name: string; path?: string | null; dirName?: string | null }` — explicit filename, optional sub-directory, optional identifier replacement

When using the string form, the optional third `dirName` argument overrides the factory-level `dirName` for this instance.

In the object form, passing `null` for `dirName` or `path` explicitly disables the factory-level value. Omitting the field (or passing `undefined`) falls back to the factory-level value.

```ts
factory.build(schema, "app.json")                                           // → <root>/app.json
factory.build(schema, "app.json", "my-app")                                 // → %APPDATA%/my-app/app.json
factory.build(schema, { name: "app.json", path: "config" })                 // → <root>/config/app.json
factory.build(schema, { name: "app.json", dirName: "my-app" })              // → %APPDATA%/my-app/app.json
factory.build(schema, { name: "cfg.json", dirName: "my-app", path: "a/b" }) // → %APPDATA%/my-app/a/b/cfg.json
```

### `ConfigurateOptions`

| Field           | Type            | Description                                                                  |
| --------------- | --------------- | ---------------------------------------------------------------------------- |
| `name`          | `string`        | Full filename including extension (`"app.json"`, `".env"`). No path separators (`/` or `\`) allowed.  |
| `dir`           | `BaseDirectory` | Base directory                                                               |
| `dirName`       | `string?`       | Replaces the identifier component of the base path                           |
| `path`          | `string?`       | Sub-directory within the root. Forward-slash separated (e.g. `"cfg/v2"`)     |
| `format`        | `StorageFormat` | `"json"`, `"yaml"`, or `"binary"`                                            |
| `encryptionKey` | `string?`       | Encryption key (binary format only)                                          |

### `Configurate<S>`

| Method           | Returns              | Description                              |
| ---------------- | -------------------- | ---------------------------------------- |
| `.create(data)`  | `LazyConfigEntry<S>` | Write a new config file                  |
| `.load()`        | `LazyConfigEntry<S>` | Read an existing config file             |
| `.save(data)`    | `LazyConfigEntry<S>` | Overwrite an existing config file        |
| `.delete(opts?)` | `Promise<void>`      | Delete the file and wipe keyring entries |

### `LazyConfigEntry<S>`

| Method          | Returns                      | Description                                           |
| --------------- | ---------------------------- | ----------------------------------------------------- |
| `.lock(opts)`   | `this`                       | Attach keyring options (chainable, before run/unlock) |
| `.run()`        | `Promise<LockedConfig<S>>`   | Execute — secrets are `null`                          |
| `.unlock(opts)` | `Promise<UnlockedConfig<S>>` | Execute — secrets are inlined (single IPC call)       |

### `LockedConfig<S>`

| Member          | Type                         | Description                               |
| --------------- | ---------------------------- | ----------------------------------------- |
| `.data`         | `InferLocked<S>`             | Config data with keyring fields as `null` |
| `.unlock(opts)` | `Promise<UnlockedConfig<S>>` | Fetch secrets without re-reading the file |

### `UnlockedConfig<S>`

| Member    | Type               | Description                          |
| --------- | ------------------ | ------------------------------------ |
| `.data`   | `InferUnlocked<S>` | Config data with all secrets inlined |
| `.lock()` | `void`             | Drop in-memory secrets (GC-assisted) |

## IPC call count

| Operation                                   | IPC calls |
| ------------------------------------------- | --------- |
| `create` / `save` (with or without keyring) | 1         |
| `load` (no keyring)                         | 1         |
| `load().unlock(opts)`                       | 1         |
| `load().run()` then `locked.unlock(opts)`   | 2         |
| `delete`                                    | 1         |

## Security considerations

- **Secrets off disk** — keyring fields are set to `null` before the file is written; the plaintext never touches the filesystem.
- **Path traversal protection** — `name`, `dirName`, and `path` components containing `..`, bare `.`, empty segments, and Windows-forbidden characters (`/ \ : * ? " < > |` and null bytes) are rejected with an `invalid payload` error.
- **Authenticated encryption** — XChaCha20-Poly1305 provides authenticated encryption; any tampering with the ciphertext is detected at read time and returns an error.
- **Binary ≠ encrypted** — `format: "binary"` without `encryptionKey` stores data as plain bincode-encoded JSON. Use `encryptionKey` when confidentiality is required.
- **Key entropy** — when using `encryptionKey`, provide a high-entropy value (≥ 128 bits of randomness). A randomly generated key stored in the OS keyring is recommended.
- **Keyring availability** — the OS keyring may not be available in all environments (e.g. headless CI). Handle `keyring error` responses gracefully in those cases.
- **In-memory secrets** — `UnlockedConfig.data` holds plaintext values in the JS heap until GC collection. JavaScript provides no guaranteed way to zero-out memory, so avoid keeping `UnlockedConfig` objects alive longer than necessary.

## License

MIT
