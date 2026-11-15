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
- [Errors](#errors)
- [Permissions](#permissions)
- [Key order (`preserve-order` feature)](#key-order-preserve-order-feature)
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

| Type                    | Description                                   |
| ----------------------- | --------------------------------------------- |
| `String`                | String field                                  |
| `Number`                | Number field (must be finite)                 |
| `Boolean`               | Boolean field                                 |
| `keyring(Type, { id })` | OS keyring-protected field                    |
| `optional(Type)`        | Optional field (may be `undefined` or `null`) |
| `json<T>()`             | Opaque JSON value (any JSON; typed as `T`)    |
| `record(Type)`          | String-keyed map whose values are all `Type`  |
| `oneOf("a", "b", ...)`  | One of the given strings                      |
| `{ ... }`               | Nested object                                 |
| `[Type]`                | Array of a single element type                |

`json()`, `record()` and `oneOf()` can be wrapped in `optional()` and used as array elements (`[json()]`, `[record(String)]`, `[oneOf("a", "b")]`).

**Type inference:**

- `InferUnlocked<S>` — Full type with keyring fields as their actual types
- `InferLocked<S>` — Type with keyring fields replaced by `null`

A key wrapped in `optional()` is inferred as an optional property (`fontSize?: number | undefined`) at every depth, including nested objects and objects inside arrays. Object literals for `create()`, `save()`, `defaults` and so on can therefore omit it; reading it still gives `number | undefined`.

### `keyring(typeCtor, opts)`

Marks a schema field as keyring-protected.

```ts
keyring(String, { id: "my-secret" });
```

| Parameter  | Type                                                           | Description                                         |
| ---------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `typeCtor` | `StringConstructor \| NumberConstructor \| BooleanConstructor` | The value type constructor                          |
| `opts.id`  | `string`                                                       | Unique identifier. Must not be empty or contain `/` |

### `optional(schema)`

Marks a field as optional. Can wrap primitives, keyring fields, objects, or arrays.

```ts
optional(Number);
optional(keyring(String, { id: "opt-secret" }));
optional({ host: String, port: Number });
optional([String]);
optional(json());
```

### `json<T>()`

Marks a field as an opaque JSON value, for shapes the schema cannot describe (for example a discriminated union). The inferred type is `unknown`, or `T` when a type argument is given. `T` is a compile-time promise only: it is not checked at runtime.

Validation (`validateOnWrite` / `validateOnRead` / `validate()`) only checks that the value is present and JSON-safe: `null`, booleans, strings, finite numbers, arrays and plain objects of those. It rejects `undefined` (as the value or as an array element), functions, symbols, `bigint`, `NaN` / `Infinity`, class instances such as `Date` or `Map`, and circular references. Object properties set to `undefined` are allowed because `JSON.stringify` drops them.

```ts
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };

const schema = defineConfig({
  shape: json<Shape>(), // Shape
  extra: optional(json()), // unknown
});
```

> **TOML:** TOML has no `null`. Inside a `json()` value, `null` object properties are dropped on write and `null` array elements are rejected, so values containing `null` do not round-trip through `TomlProvider`.

### `record(schema)`

Marks a field as a string-keyed map. Every value follows `schema`, which can be a primitive, a nested object, an array, or another marker (`json()`, `record()`, `oneOf()`). The inferred type is `Record<string, ...>`.

```ts
const schema = defineConfig({
  shortcuts: record(String), // Record<string, string>
  panes: record({ width: Number, pinned: optional(Boolean) }),
  groups: record([String]), // Record<string, string[]>
});
```

- Keyring fields are **not supported** anywhere inside a `record()` (keyring entries are tied to a fixed field path). `defineConfig()` and the `Configurate` constructor throw when they find one.
- `record(optional(...))` is rejected; leave the key out instead.

### `oneOf(...values)`

Marks a field as one of the given strings. The inferred type is their literal union, and validation rejects any other value.

```ts
const schema = defineConfig({
  theme: oneOf("light", "dark", "system"), // "light" | "dark" | "system"
});
```

`oneOf()` needs at least one value, and every value must be a string.

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
BinaryProvider(); // Unencrypted (compact JSON bytes)
BinaryProvider({ encryptionKey: "key" }); // XChaCha20-Poly1305 with SHA-256 KDF
BinaryProvider({ encryptionKey: "key", kdf: "argon2" }); // XChaCha20-Poly1305 with Argon2id KDF
```

| Option          | Type                   | Default     | Description                          |
| --------------- | ---------------------- | ----------- | ------------------------------------ |
| `encryptionKey` | `string?`              | `undefined` | Encryption key. Omit for unencrypted |
| `kdf`           | `"sha256" \| "argon2"` | `"sha256"`  | Key derivation function              |

## Configurate Class

### Constructor

```ts
new Configurate<S>(opts: ConfigurateInit<S>)
```

| Option                        | Type                         | Required | Description                                                                                          |
| ----------------------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `schema`                      | `S`                          | Yes      | Schema object from `defineConfig()`                                                                  |
| `fileName`                    | `string`                     | Yes      | Config file name (no path separators)                                                                |
| `baseDir`                     | `BaseDirectory`              | Yes      | Tauri base directory                                                                                 |
| `provider`                    | `ConfigurateProvider`        | Yes      | Storage provider                                                                                     |
| `options`                     | `ConfiguratePathOptions?`    | No       | Path customization (see [Path options](#path-options))                                               |
| `options.dirName`             | `string?`                    | No       | Relative sub-path under the resolved `baseDir` (`/` or `\` segments)                                 |
| `options.currentPath`         | `string?`                    | No       | Additional relative sub-path under the `dirName` root (or under `baseDir` when `dirName` is omitted) |
| `validation`                  | `SchemaValidationOptions?`   | No       | Schema validation settings                                                                           |
| `validation.validateOnWrite`  | `boolean`                    | No       | Validate on create/save (default: `false`)                                                           |
| `validation.validateOnRead`   | `boolean`                    | No       | Validate on load/unlock (default: `false`)                                                           |
| `validation.allowUnknownKeys` | `boolean`                    | No       | Allow undeclared keys (default: `false`)                                                             |
| `defaults`                    | `Partial<InferUnlocked<S>>?` | No       | Default values to fill on load (see [Defaults](#defaults))                                           |
| `version`                     | `number?`                    | No       | Schema version for migration                                                                         |
| `migrations`                  | `MigrationStep[]?`           | No       | Ordered migration steps                                                                              |

#### Path options

Config files are resolved as:

```text
{baseDir}/{dirName?}/{currentPath?}/{fileName}
```

- **`baseDir`** — Tauri `BaseDirectory` (default allowlist: app-scoped directories). Resolved by the plugin to an absolute path on disk.
- **`dirName`** — Optional relative path appended **under** `baseDir`. It never replaces the app-identifier segment or escapes the resolved base directory.
- **`currentPath`** — Optional relative path appended under the `dirName` root (or directly under `baseDir` when `dirName` is omitted).

**Segment rules** (enforced in guest-js and Rust for `fileName`, `dirName`, and `currentPath`):

| Rule                                                                             | Example (rejected) |
| -------------------------------------------------------------------------------- | ------------------ |
| Single component for `fileName` (no separators)                                  | `sub/file.json`    |
| No empty segments                                                                | `a//b`, `a\`       |
| No dot-only segments (`.`, `..`, `...`)                                          | `a/../b`           |
| No Windows-forbidden characters (`: * ? " < > \|` and null bytes)                | `foo:bar`          |
| Segments must not end with a space or dot                                        | `bad `, `bad.`     |
| `/` and `\` are both accepted as segment separators in `dirName` / `currentPath` | —                  |

**0.5.1 migration:** Versions before 0.5.1 could resolve `dirName` outside the app sandbox when it replaced the app-identifier directory segment. Upgrade to nested paths under `baseDir`, or pick a `BaseDirectory` that already points at the target folder. See [CHANGELOG](./CHANGELOG.md#051---2026-06-11).

```ts
// App-scoped nested layout (recommended)
new Configurate({
  schema,
  fileName: "settings.json",
  baseDir: BaseDirectory.AppConfig,
  provider: JsonProvider(),
  options: {
    dirName: "profiles",
    currentPath: "v2",
  },
});
// → {AppConfig}/profiles/v2/settings.json
```

#### Defaults

`defaults` is applied on every load (`load()`, `loadAll()`, `exportAs()`), after migrations and **before** `validateOnRead`:

- A key that is missing, `undefined` or `null` in the stored data is filled with the default value.
- Nested objects are merged key by key, so a default fills missing keys inside a stored object.
- Arrays are never merged: a stored array is kept as it is, and a missing or `null` array is replaced by the default array.
- `json()` and `record()` fields are filled only as a whole: when the stored value exists, the default is not merged into it.
- Defaults are not written back to the file, except when a migration runs: the migrated data is saved with the defaults already filled in.

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

| Method              | Returns                      | Description                                    |
| ------------------- | ---------------------------- | ---------------------------------------------- |
| `.run()`            | `Promise<LockedConfig<S>>`   | Execute and return locked data                 |
| `.lock(opts).run()` | `Promise<LockedConfig<S>>`   | Store secrets in keyring, return locked data   |
| `.unlock(opts)`     | `Promise<UnlockedConfig<S>>` | Store secrets in keyring, return unlocked data |

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

Writes the config file, replacing its whole content. The file does not need to exist: missing parent directories (for example a `dirName` folder) are created. `create()`, `reset()` and `patch().createIfMissing()` create parent directories the same way.

When `.run()` or `.lock(opts).run()` is used, the returned `LockedConfig` is built from the data you passed (keyring fields set to `null`); the plugin does not send the written data back over IPC. `.unlock(opts)` asks for it because it returns the unlocked data.

```ts
await config
  .save({ theme: "light", database: { host: "db.example.com", password: "new-secret" } })
  .lock(keyringOpts)
  .run();
```

**Returns:** `LazyConfigEntry<S>`

---

#### `config.delete(keyringOpts?)`

Deletes the config file and associated keyring entries.

Deleting a file that does not exist succeeds, and keyring entries that do not exist are skipped, so `delete()` can be called without checking `exists()` first.

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

- Objects are merged key by key; arrays and other values are replaced.
- `null` stores `null`; it does not delete the key.
- This applies to `json()` and `record()` values too: patching a `record()` adds or updates entries but cannot remove one, and patching a `json()` object merges into the stored object. Use `save()` to replace such a value as a whole.
- With `validateOnWrite`, patch data is validated as a partial: nested objects (including `record()` entries) may be partial, but array elements, `json()` and `oneOf()` values are checked in full.
- Patching a file that does not exist rejects with `kind: "invalid_payload"` (not a not-found error) unless `.createIfMissing()` is used.

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

| Method               | Returns                      | Description                                    |
| -------------------- | ---------------------------- | ---------------------------------------------- |
| `.run()`             | `Promise<PatchedConfig<S>>`  | Execute patch, return locked result            |
| `.lock(opts).run()`  | `Promise<PatchedConfig<S>>`  | Patch with keyring, return locked result       |
| `.createIfMissing()` | `this`                       | Create config if not found instead of throwing |
| `.unlock(opts)`      | `Promise<UnlockedConfig<S>>` | Patch with keyring, return unlocked result     |

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

| Method              | Returns                      | Description                              |
| ------------------- | ---------------------------- | ---------------------------------------- |
| `.run()`            | `Promise<LockedConfig<S>>`   | Reset and return locked data             |
| `.lock(opts).run()` | `Promise<LockedConfig<S>>`   | Reset with keyring, return locked data   |
| `.unlock(opts)`     | `Promise<UnlockedConfig<S>>` | Reset with keyring, return unlocked data |

---

### Exists / List

#### `config.exists()`

Checks whether the config entry exists.

```ts
const present: boolean = await config.exists();
```

#### `config.list()`

Lists config file names in the resolved root directory (`{baseDir}/{dirName?}/{currentPath?}`). The instance's `fileName` is ignored.

- Scans the directory for files with the provider's extension (`.json`, `.yml`, `.toml`; any file for `BinaryProvider`). Backup files (`.bak*`) and temp files are excluded.
- A directory that does not exist yields an empty list.

```ts
const files: string[] = await config.list();
// ["app.json", "user.json", "settings.json"]
```

#### `Configurate.list({ baseDir, provider, options? })`

Static form of `list()` for when there is no `Configurate` instance (no schema or `fileName` needed). `baseDir`, `provider` and `options` follow the same rules as the [constructor](#constructor), and it uses the same `list_configs` command and permission.

```ts
const sessions = await Configurate.list({
  baseDir: BaseDirectory.AppData,
  provider: JsonProvider(),
  options: { dirName: "sessions" },
});
// ["0b6f….json", "4c1e….json"]
```

The static form needs a plugin crate from the same release (older crates reject a listing payload without `fileName`).

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

| Parameter     | Type                        | Description                                              |
| ------------- | --------------------------- | -------------------------------------------------------- |
| `format`      | `"json" \| "yml" \| "toml"` | Target serialization format                              |
| `keyringOpts` | `KeyringOptions?`           | When provided, keyring fields are unlocked before export |

**Returns:** `Promise<string>`

#### `config.importFrom(content, format, keyringOpts?)`

Imports config data from a string, replacing the current stored config.

```ts
await config.importFrom('{"theme": "dark"}', "json");
await config.importFrom("theme: dark\n", "yml");
await config.importFrom('theme = "dark"\n', "toml", keyringOpts);
```

| Parameter     | Type                        | Description                                                          |
| ------------- | --------------------------- | -------------------------------------------------------------------- |
| `content`     | `string`                    | Serialized config string                                             |
| `format`      | `"json" \| "yml" \| "toml"` | Source format                                                        |
| `keyringOpts` | `KeyringOptions?`           | Required to import decrypted values for schemas that use `keyring()` |

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
config.validatePartial({ theme: 123 }); // throws
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
  fileName: string; // Config file name
  operation: string; // "create" | "save" | "patch" | "delete" | "reset" | "import" | "external_change"
  targetId: string; // Unique identifier for this config target
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
  .unlock("secret", keyringOpts) // unlock specific entry
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
  .lock("secret", keyringOpts) // lock specific entry
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
  get data(): InferUnlocked<S>; // throws after lock()
  lock(): void; // revokes access to data
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

type BatchRunEntryResult = { ok: true; data: unknown } | { ok: false; error: ConfigurateError };
```

See [Errors](#errors) for `ConfigurateError`.

### `KeyringOptions`

```ts
interface KeyringOptions {
  service: string; // Keyring service name (e.g. your app name)
  account: string; // Keyring account name (e.g. "default")
}
```

---

## Errors

Commands that fail in Rust reject with a plain object (not an `Error` instance):

```ts
interface ConfigurateError {
  kind: ConfigurateErrorKind;
  message: string; // human-readable; do not parse it
  io_kind?: ConfigurateIoErrorKind; // only when kind === "io"
}
```

| `kind`                 | Source        | Meaning                                                         |
| ---------------------- | ------------- | --------------------------------------------------------------- |
| `io`                   | Rust          | File system error; see `io_kind`                                |
| `storage`              | Rust          | The file could not be parsed, decrypted or serialized           |
| `json`                 | Rust          | `serde_json` error (for example invalid JSON in a `.json` file) |
| `keyring`              | Rust          | OS keyring error                                                |
| `dotpath`              | Rust          | Invalid keyring field path                                      |
| `invalid_payload`      | Rust          | Rejected request (bad path, `patch` on a missing file, ...)     |
| `plugin_invoke`        | Rust (mobile) | Mobile plugin error (mobile is not supported)                   |
| `unknown`              | Rust / guest  | Error that could not be classified                              |
| `post_load_failed`     | guest, batch  | Migration or defaults failed after `loadAll()` read the file    |
| `schema_validation`    | guest, batch  | `validateOnRead` failed for a `loadAll()` entry                 |
| `unlock_failed`        | guest, batch  | Keyring unlock failed for a `loadAll()` entry                   |
| `payload_build_failed` | guest, batch  | `saveAll()` / `patchAll()` entry was rejected before IPC        |

`io_kind` is one of `not_found`, `permission_denied`, `already_exists`, `would_block`, `invalid_input`, `timed_out`, `interrupted`, `out_of_memory`, `other`. Both `ConfigurateErrorKind` and `ConfigurateIoErrorKind` also accept other strings, so new kinds can be added without a breaking change.

Guest-side failures of single calls (schema validation, missing `.lock()`, invalid paths) are thrown as `Error` instances. Rejections that happen before the command runs, such as a missing permission or a malformed payload, come from Tauri as plain strings. Batch results convert them to `ConfigurateError` with the kinds marked "guest, batch" above.

### `isNotFoundError(error)`

Returns true only for the "file does not exist" error (`kind: "io"`, `io_kind: "not_found"`), and narrows `error` to `ConfigurateError`. Use it to tell a missing file from a broken one:

```ts
import { isNotFoundError } from "tauri-plugin-configurate-api";

try {
  const { data } = await config.load().run();
} catch (e) {
  if (isNotFoundError(e)) {
    // first run: nothing stored yet
  } else {
    throw e; // the file exists but could not be read, parsed or validated
  }
}
```

It works on `loadAll()` results too (`isNotFoundError(result.error)`).

---

## Permissions

`configurate:default` grants every command except `unlock`, including `delete`, `reset`, `import_config` and `export_config`. Prefer granting only the commands your app uses:

```json
{
  "permissions": [
    "configurate:allow-load",
    "configurate:allow-save",
    "configurate:allow-list-configs"
  ]
}
```

| API                                                                                            | Permissions needed                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `create()`                                                                                     | `allow-create`                                                         |
| `load()`                                                                                       | `allow-load`                                                           |
| `save()`                                                                                       | `allow-save`                                                           |
| `patch()`                                                                                      | `allow-patch`                                                          |
| `reset()`                                                                                      | `allow-reset`                                                          |
| `delete()`                                                                                     | `allow-delete`                                                         |
| `exists()`                                                                                     | `allow-exists`                                                         |
| `list()`, `Configurate.list()`                                                                 | `allow-list-configs`                                                   |
| `exportAs()`                                                                                   | `allow-load`, `allow-export-config`                                    |
| `importFrom()`                                                                                 | `allow-import-config`                                                  |
| `watchExternal()`                                                                              | `allow-watch-file`, `allow-unwatch-file`                               |
| `Configurate.loadAll()` / `saveAll()` / `patchAll()`                                           | `allow-load-all` / `allow-save-all` / `allow-patch-all`                |
| `.unlock()` on a load, `LockedConfig.unlock()`, `loadAll().unlock()`, `exportAs(format, opts)` | `allow-unlock` (not in `configurate:default`)                          |
| `onChange()`                                                                                   | none from this plugin (it listens to the `configurate://change` event) |

Some calls use more than one command:

- With `version` and `migrations`, a load that migrates older data saves it back, so it also needs `allow-save`.
- When the schema has keyring fields, `create()` / `save()` / `reset()` / `saveAll()` with `.lock(opts)` or `.unlock(opts)`, and `importFrom(content, format, opts)`, first read the stored file to remove stale keyring entries, so they also need `allow-load`.
- `delete(opts)` reads the stored file first when keyring fields sit inside arrays, so it also needs `allow-load` in that case.

All permission identifiers are listed in [`permissions/autogenerated/reference.md`](./permissions/autogenerated/reference.md).

---

## Key order (`preserve-order` feature)

By default every provider writes object keys sorted alphabetically (the default `serde_json::Map` is a `BTreeMap`). This holds only while no crate in your app's build enables `serde_json/preserve_order`; if one does, keys already keep insertion order. Enable the `preserve-order` Cargo feature to keep the order of the object you pass:

```toml
tauri-plugin-configurate = { version = "...", features = ["preserve-order"] }
```

With the feature on:

- JSON, YAML and Binary files keep the key order of the data passed to `create()` / `save()` / `reset()`, which is the JavaScript insertion order (JavaScript itself lists integer-like keys such as `"1"` first). The order comes from the data, not from the schema.
- TOML keeps the order too, except that tables (nested objects) are written after plain keys, as TOML requires.
- `patch()` keeps stored keys where they are and appends new keys at the end of their object.
- The guest appends the schema version key (`__configurate_version__`) at the end, and `defaults` fill missing keys at the end of their object on load.

> **Caveat:** Cargo unifies features. The feature turns on `serde_json/preserve_order` and `toml/preserve_order`, so `serde_json::Map` and `toml::map::Map` keep insertion order for **every** crate in your app's build, not only for this plugin.

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
  path: string; // Dot-separated path
  type: "added" | "removed" | "changed"; // Kind of change
  oldValue?: unknown; // Previous value (for "removed" and "changed")
  newValue?: unknown; // New value (for "added" and "changed")
}
```

Nested objects are compared recursively using dot-separated paths (e.g. `"database.host"`).

---

### `MigrationStep`

Used with the `version` and `migrations` options for schema versioning.

```ts
interface MigrationStep<TData> {
  version: number; // The version this migration upgrades FROM
  up: (data: TData) => TData; // Transform function
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
    {
      version: 1,
      up: (data) => {
        delete data.oldField;
        return data;
      },
    },
  ],
});
```

Migrations run automatically on `load()`. If data is migrated, it is auto-saved back to storage.
