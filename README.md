# tauri-plugin-configurate

A Tauri v2 plugin for type-safe application configuration management.

Define your config schema once in TypeScript and get full type inference for reads and writes. Supports JSON, YAML, and encrypted binary formats, with first-class OS keyring integration for storing secrets securely off disk.

## Features

- **Type-safe schema** — define your config shape with `defineConfig()` and get compile-time checked reads/writes
- **OS keyring support** — mark fields with `keyring()` to store secrets in the native credential store (Keychain / Credential Manager / libsecret) and keep them off disk
- **Multiple formats** — JSON (human-readable), YAML (human-readable), binary (compact), or encrypted binary (XChaCha20-Poly1305)
- **Minimal IPC** — every operation (file read + keyring fetch) is batched into a single IPC round-trip
- **Multiple config files** — use `ConfigurateFactory` to manage multiple files with different schemas from one place
- **Path traversal protection** — config identifiers and sub-directory paths are validated before use as file names; `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, `.`, `..`, and null bytes are all rejected

## Installation

### Rust

Add the plugin to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-configurate = { path = "/path/to/tauri-plugin-configurate" }
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

`ConfigurateFactory` holds shared options (`dir`, `format`, optional `subDir`, optional `encryptionKey`) and produces `Configurate` instances — one per config file.

```ts
const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "json",
  // Optional: store all files under <AppConfig>/my-app/
  // subDir: "my-app",
});
```

> **`subDir`** — a forward-slash-separated relative path (e.g. `"my-app"` or `"my-app/config"`) appended between the base directory and the config file name. Each path component must not be empty, `.`, `..`, or contain Windows-forbidden characters. When omitted, files are written directly into `dir`.

### 3. Build a `Configurate` instance

```ts
const appConfig = factory.build(appSchema, "app"); // → app.json

// Override the factory-level subDir for one specific file:
const specialConfig = factory.build(specialSchema, "special", "other-dir"); // → <AppConfig>/other-dir/special.json
```

Each call to `build()` can use a different schema, `id`, and/or `subDir`.

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

Use `ConfigurateFactory` to manage several config files — each can have a different schema, id, or format.

```ts
const appSchema = defineConfig({ theme: String, language: String });
const cacheSchema = defineConfig({ lastSync: Number });
const secretSchema = defineConfig({
  token: keyring(String, { id: "api-token" }),
});

const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "json",
  subDir: "my-app", // all files stored under <AppConfig>/my-app/
});

const appConfig    = factory.build(appSchema,    "app");     // → my-app/app.json
const cacheConfig  = factory.build(cacheSchema,  "cache");   // → my-app/cache.json
const secretConfig = factory.build(secretSchema, "secrets"); // → my-app/secrets.json

// Override subDir per-file when needed:
const legacyConfig = factory.build(legacySchema, "legacy", "old-dir"); // → old-dir/legacy.json

// Each instance is a full Configurate — all operations are available
const app = await appConfig.load().run();
const cache = await cacheConfig.load().run();
```

## Encrypted binary format

Set `format: "binary"` and provide an `encryptionKey` to store config files encrypted with **XChaCha20-Poly1305**. The 32-byte cipher key is derived internally via SHA-256, so any high-entropy string is suitable — a random key stored in the OS keyring is ideal.

Encrypted files use the **`.binc`** extension (plain binary files use `.bin`). Never mix backends: opening a `.binc` file with the wrong or missing key returns an error; opening a plain `.bin` file with an `encryptionKey` also returns a decryption error.

```ts
const encKey = await getEncryptionKeyFromKeyring(); // your own retrieval logic

const factory = new ConfigurateFactory({
  dir: BaseDirectory.AppConfig,
  format: "binary",
  encryptionKey: encKey,
});

const config = factory.build(appSchema, "app"); // → app.binc (encrypted)

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

`ConfigurateBaseOptions` is `ConfigurateOptions` without `id`:

| Field           | Type            | Description                                         |
| --------------- | --------------- | --------------------------------------------------- |
| `dir`           | `BaseDirectory` | Base directory for all files                        |
| `subDir`        | `string?`       | Sub-directory path relative to `dir` (optional)     |
| `format`        | `StorageFormat` | `"json"`, `"yaml"`, or `"binary"`                   |
| `encryptionKey` | `string?`       | Encryption key (binary format only, yields `.binc`) |

#### `factory.build(schema, id, subDir?)`

Returns a `Configurate<S>` for the given schema and file stem. The optional `subDir` argument overrides the factory-level `subDir` for this specific instance.

```ts
factory.build(schema, "app")               // → <dir>/app.json
factory.build(schema, "app", "my-app")    // → <dir>/my-app/app.json
```

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
- **Path traversal protection** — config IDs and `subDir` components containing `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, bare `.` or `..`, and null bytes are rejected with an `invalid payload` error.
- **Encrypted binary (`.binc`)** — XChaCha20-Poly1305 provides authenticated encryption; any tampering with the ciphertext is detected at read time and returns an error. Encrypted files are distinguished from plain binary (`.bin`) by their extension.
- **Binary ≠ encrypted** — `format: "binary"` without `encryptionKey` stores data as plain bincode-encoded JSON (`.bin`). Use `encryptionKey` when confidentiality is required.
- **Key entropy** — when using `encryptionKey`, provide a high-entropy value (≥ 128 bits of randomness). A randomly generated key stored in the OS keyring is recommended.
- **Keyring availability** — the OS keyring may not be available in all environments (e.g. headless CI). Handle `keyring error` responses gracefully in those cases.
- **In-memory secrets** — `UnlockedConfig.data` holds plaintext values in the JS heap until GC collection. JavaScript provides no guaranteed way to zero-out memory, so avoid keeping `UnlockedConfig` objects alive longer than necessary.

## License

MIT
