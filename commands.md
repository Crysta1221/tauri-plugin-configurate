# TypeScript API Reference

Complete API reference for `tauri-plugin-configurate-api`.

---

## Table of Contents

- [Schema Definition](#schema-definition)
- [Providers](#providers)
- [Configurate Class](#configurate-class)
  - [Constructor](#constructor)
  - [CRUD Operations](#crud-operations)
  - [Patch](#patch)
  - [Reset](#reset)
  - [Exists / List](#exists--list)
  - [Export / Import](#export--import)
  - [Validation](#validation)
  - [File Watching](#file-watching)
  - [Batch Operations](#batch-operations)
- [Result Types](#result-types)
- [Utility Functions](#utility-functions)

---

## Schema Definition

### `defineConfig(schema)`

Defines and validates a config schema object. Returns the schema unchanged (used for type inference).

```ts
import { defineConfig, keyring, optional } from "tauri-plugin-configurate-api";

const schema = defineConfig({
  theme: String,
  fontSize: optional(Number),
  apiKey: keyring(String, { id: "api-key" }),
  database: {
    host: String,
    port: Number,
    password: keyring(String, { id: "db-password" }),
  },
  tags: [String],
});
```

**Schema value types:**

| Type | Description |
|------|-------------|
| `String` | String field |
| `Number` | Number field (must be finite) |
| `Boolean` | Boolean field |
| `keyring(Type, { id })` | OS keyring-protected field |
| `optional(Type)` | Optional field (may be `undefined` or `null`) |
| `{ ... }` | Nested object |
| `[Type]` | Array of a single element type |

**Type inference:**

- `InferUnlocked<S>` — Full type with keyring fields as their actual types
- `InferLocked<S>` — Type with keyring fields replaced by `null`

### `keyring(typeCtor, opts)`

Marks a schema field as keyring-protected.

```ts
keyring(String, { id: "my-secret" })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `typeCtor` | `StringConstructor \| NumberConstructor \| BooleanConstructor` | The value type constructor |
| `opts.id` | `string` | Unique identifier. Must not be empty or contain `/` |

### `optional(schema)`

Marks a field as optional. Can wrap primitives, keyring fields, objects, or arrays.

```ts
optional(Number)
optional(keyring(String, { id: "opt-secret" }))
optional({ host: String, port: Number })
optional([String])
```

---

## Providers

All providers return a branded `ConfigurateProvider` object.

### `JsonProvider()`

Plain JSON file storage. Human-readable, pretty-printed.

### `YmlProvider()`

YAML file storage.

### `TomlProvider()`

TOML file storage.

> **Note:** TOML has no native `null` type. Fields with `null` values are silently omitted on write and will be absent on the next load.

### `BinaryProvider(opts?)`

Binary file storage with optional encryption.

```ts
BinaryProvider()                                          // Unencrypted (compact JSON bytes)
BinaryProvider({ encryptionKey: "key" })                  // XChaCha20-Poly1305 with SHA-256 KDF
BinaryProvider({ encryptionKey: "key", kdf: "argon2" })   // XChaCha20-Poly1305 with Argon2id KDF
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `encryptionKey` | `string?` | `undefined` | Encryption key. Omit for unencrypted |
| `kdf` | `"sha256" \| "argon2"` | `"sha256"` | Key derivation function |

### `SqliteProvider(opts?)`

SQLite database storage. Schema fields are materialized as typed columns.

```ts
SqliteProvider()
SqliteProvider({ dbName: "app.db", tableName: "settings" })
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbName` | `string?` | `"configurate.db"` | Database file name |
| `tableName` | `string?` | `"configurate_configs"` | Table name |

---

## Configurate Class

### Constructor

```ts
new Configurate<S>(opts: ConfigurateInit<S>)
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `schema` | `S` | Yes | Schema object from `defineConfig()` |
| `fileName` | `string` | Yes | Config file name (no path separators) |
| `baseDir` | `BaseDirectory` | Yes | Tauri base directory |
| `provider` | `ConfigurateProvider` | Yes | Storage provider |
| `options` | `ConfiguratePathOptions?` | No | Path customization |
| `options.dirName` | `string?` | No | Replaces app-identifier directory segment |
| `options.currentPath` | `string?` | No | Sub-directory within root |
| `validation` | `SchemaValidationOptions?` | No | Schema validation settings |
| `validation.validateOnWrite` | `boolean` | No | Validate on create/save (default: `false`) |
| `validation.validateOnRead` | `boolean` | No | Validate on load/unlock (default: `false`) |
| `validation.allowUnknownKeys` | `boolean` | No | Allow undeclared keys (default: `false`) |
| `defaults` | `Partial<InferUnlocked<S>>?` | No | Default values to fill on load |
| `version` | `number?` | No | Schema version for migration |
| `migrations` | `MigrationStep[]?` | No | Ordered migration steps |

---

### CRUD Operations

#### `config.create(data)`

Creates a new config file.

```ts
const entry = config.create({
  theme: "dark",
  database: { host: "localhost", password: "secret" },
});

// Without keyring
const locked = await entry.run();

// With keyring (required when schema has keyring fields)
const locked = await entry.lock(keyringOpts).run();

// Get unlocked data back
const unlocked = await entry.unlock(keyringOpts);
```

**Returns:** `LazyConfigEntry<S>`

| Method | Returns | Description |
|--------|---------|-------------|
| `.run()` | `Promise<LockedConfig<S>>` | Execute and return locked data |
| `.lock(opts).run()` | `Promise<LockedConfig<S>>` | Store secrets in keyring, return locked data |
| `.unlock(opts)` | `Promise<UnlockedConfig<S>>` | Store secrets in keyring, return unlocked data |

---

#### `config.load()`

Loads an existing config file.

```ts
// Locked — keyring fields are null
const locked = await config.load().run();
console.log(locked.data.database.password); // null

// Unlocked — keyring fields are populated
const unlocked = await config.load().unlock(keyringOpts);
console.log(unlocked.data.database.password); // "secret"

// Unlock from locked data
const unlocked2 = await locked.unlock(keyringOpts);
```

**Returns:** `LazyConfigEntry<S>`

---

#### `config.save(data)`

Overwrites an existing config file completely.

```ts
await config.save({ theme: "light", database: { host: "db.example.com", password: "new-secret" } })
  .lock(keyringOpts)
  .run();
```

**Returns:** `LazyConfigEntry<S>`

---

#### `config.delete(keyringOpts?)`

Deletes the config file and associated keyring entries.

```ts
await config.delete(keyringOpts);
// or without keyring:
await config.delete();
```

**Returns:** `Promise<void>`

---

### Patch

#### `config.patch(partial)`

Partially updates an existing config by deep-merging. Omitted keys are left unchanged.

```ts
const entry = config.patch({ theme: "dark" });

// Run without keyring
const patched = await entry.run();

// Run with keyring
const patched = await entry.lock(keyringOpts).run();

// Create the config if it doesn't exist
const patched = await entry.createIfMissing().run();

// Run and get unlocked result
const unlocked = await entry.unlock(keyringOpts);
```

**Returns:** `LazyPatchEntry<S>`

| Method | Returns | Description |
|--------|---------|-------------|
| `.run()` | `Promise<PatchedConfig<S>>` | Execute patch, return locked result |
| `.lock(opts).run()` | `Promise<PatchedConfig<S>>` | Patch with keyring, return locked result |
| `.createIfMissing()` | `this` | Create config if not found instead of throwing |
| `.unlock(opts)` | `Promise<UnlockedConfig<S>>` | Patch with keyring, return unlocked result |

---

### Reset

#### `config.reset(data)`

Deletes the existing config and re-creates it with the provided data.

```ts
const entry = config.reset({
  theme: "dark",
  language: "en",
  database: { host: "localhost", password: "secret" },
});

// With keyring
const locked = await entry.lock(keyringOpts).run();

// Get unlocked result
const unlocked = await entry.unlock(keyringOpts);
```

**Returns:** `LazyResetEntry<S>`

| Method | Returns | Description |
|--------|---------|-------------|
| `.run()` | `Promise<LockedConfig<S>>` | Reset and return locked data |
| `.lock(opts).run()` | `Promise<LockedConfig<S>>` | Reset with keyring, return locked data |
| `.unlock(opts)` | `Promise<UnlockedConfig<S>>` | Reset with keyring, return unlocked data |

---

### Exists / List

#### `config.exists()`

Checks whether the config entry exists.

```ts
const present: boolean = await config.exists();
```

#### `config.list()`

Lists config file names in the resolved root directory.

- **File-based providers:** Scans the directory for files matching the provider's extension. Backup files (`.bak*`) and temp files are excluded.
- **SQLite:** Returns all `config_key` values in the table.

```ts
const files: string[] = await config.list();
// ["app.json", "user.json", "settings.json"]
```

---

### Export / Import

#### `config.exportAs(format, keyringOpts?)`

Exports the stored config data as a formatted string.

```ts
const jsonStr = await config.exportAs("json");
const yamlStr = await config.exportAs("yml");
const tomlStr = await config.exportAs("toml");
const yamlWithSecrets = await config.exportAs("yml", keyringOpts);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `format` | `"json" \| "yml" \| "toml"` | Target serialization format |
| `keyringOpts` | `KeyringOptions?` | When provided, keyring fields are unlocked before export |

**Returns:** `Promise<string>`

#### `config.importFrom(content, format, keyringOpts?)`

Imports config data from a string, replacing the current stored config.

```ts
await config.importFrom('{"theme": "dark"}', "json");
await config.importFrom("theme: dark\n", "yml");
await config.importFrom('theme = "dark"\n', "toml", keyringOpts);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `content` | `string` | Serialized config string |
| `format` | `"json" \| "yml" \| "toml"` | Source format |
| `keyringOpts` | `KeyringOptions?` | Required to import decrypted values for schemas that use `keyring()` |

**Returns:** `Promise<void>`

---

### Validation

#### `config.validate(data)`

Validates full config data against the schema without writing to storage. Throws on validation failure.

```ts
try {
  config.validate({
    theme: "dark",
    database: { host: "localhost", password: "secret" },
  });
  console.log("Valid!");
} catch (e) {
  console.error(e.message);
}
```

#### `config.validatePartial(data)`

Validates partial config data against the schema. Only provided keys are checked.

```ts
config.validatePartial({ theme: "dark" }); // OK
config.validatePartial({ theme: 123 });    // throws
```

---

### File Watching

#### `config.watchExternal(callback)`

Watches the config file for changes made by external processes. File-based providers only (throws for SQLite).

```ts
const stopWatching = await config.watchExternal((event) => {
  console.log(`External change detected: ${event.operation}`);
});

// Later
await stopWatching();
```

**Returns:** `Promise<() => Promise<void>>` — async function to stop watching

#### `config.onChange(callback)`

Registers a callback for any config change (create, save, patch, delete, reset, import).

```ts
const unlisten = await config.onChange((event) => {
  console.log(`Config ${event.operation} on ${event.fileName}`);
});

// Later
unlisten();
```

**Returns:** `Promise<() => void>` — function to stop listening

#### `ConfigChangeEvent`

```ts
interface ConfigChangeEvent {
  fileName: string;   // Config file name
  operation: string;  // "create" | "save" | "patch" | "delete" | "reset" | "import" | "external_change"
  targetId: string;   // Unique identifier for this config target
}
```

---

### Batch Operations

#### `Configurate.loadAll(entries)`

Loads multiple configs in a single IPC call.

Batch loads apply the same post-load defaults and migration processing as
`config.load()`.

```ts
const result = await Configurate.loadAll([
  { id: "app", config: appConfig },
  { id: "secret", config: secretConfig },
])
  .unlock("secret", keyringOpts)    // unlock specific entry
  // .unlockAll(keyringOpts)         // or unlock all entries
  .run();

if (result.results.app.ok) {
  console.log(result.results.app.data);
}
```

#### `Configurate.saveAll(entries)`

Saves multiple configs in a single IPC call.

```ts
const result = await Configurate.saveAll([
  { id: "app", config: appConfig, data: { theme: "dark" } },
  { id: "secret", config: secretConfig, data: { token: "tok" } },
])
  .lock("secret", keyringOpts)     // lock specific entry
  // .lockAll(keyringOpts)          // or lock all entries
  .run();
```

#### `Configurate.patchAll(entries)`

Patches multiple configs in a single IPC call.

```ts
const result = await Configurate.patchAll([
  { id: "app", config: appConfig, data: { theme: "light" } },
])
  .lock("app", keyringOpts)
  .run();
```

---

## Result Types

### `LockedConfig<S>`

Wrapper for loaded config data with keyring fields as `null`.

```ts
class LockedConfig<S> {
  readonly data: InferLocked<S>;
  unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>>;
}
```

### `UnlockedConfig<S>`

Wrapper for config data with keyring fields populated. Access is revoked after calling `lock()`.

```ts
class UnlockedConfig<S> {
  get data(): InferUnlocked<S>;  // throws after lock()
  lock(): void;                  // revokes access to data
}
```

### `PatchedConfig<S>`

Wrapper for the locked result of a patch operation.

```ts
class PatchedConfig<S> {
  readonly data: Partial<InferLocked<S>>;
}
```

### `BatchRunResult`

```ts
interface BatchRunResult {
  results: Record<string, BatchRunEntryResult>;
}

type BatchRunEntryResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { kind: string; message: string } };
```

### `KeyringOptions`

```ts
interface KeyringOptions {
  service: string;  // Keyring service name (e.g. your app name)
  account: string;  // Keyring account name (e.g. "default")
}
```

---

## Utility Functions

### `configDiff(oldData, newData)`

Computes a structural diff between two config objects.

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

**Returns:** `DiffEntry[]`

```ts
interface DiffEntry {
  path: string;                           // Dot-separated path
  type: "added" | "removed" | "changed";  // Kind of change
  oldValue?: unknown;                     // Previous value (for "removed" and "changed")
  newValue?: unknown;                     // New value (for "added" and "changed")
}
```

Nested objects are compared recursively using dot-separated paths (e.g. `"database.host"`).

---

### `MigrationStep`

Used with the `version` and `migrations` options for schema versioning.

```ts
interface MigrationStep<TData> {
  version: number;          // The version this migration upgrades FROM
  up: (data: TData) => TData;  // Transform function
}
```

Example:

```ts
const config = new Configurate({
  schema,
  fileName: "app.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
  version: 2,
  migrations: [
    { version: 0, up: (data) => ({ ...data, newField: "default" }) },
    { version: 1, up: (data) => { delete data.oldField; return data; } },
  ],
});
```

Migrations run automatically on `load()`. If data is migrated, it is auto-saved back to storage.
