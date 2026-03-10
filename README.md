# tauri-plugin-configurate

Tauri v2 plugin for type-safe configuration management with keyring support.

## Features

- 🛡️ Type-safe schema with `defineConfig()`
- 🔑 Keyring integration via `keyring()`
- 🧩 Providers for JSON / YML / Binary / SQLite
- 📄 Single-file APIs: `create/load/save/delete/unlock`
- 📦 Batch APIs: `loadAll/saveAll` with one IPC per batch
- 🗂️ Path controls via `baseDir` + `options.{dirName,currentPath}`

## Installation

### Use Tauri CLI

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

### Rust

```toml
[dependencies]
tauri-plugin-configurate = "0.x.x"
```

Register plugin in `src-tauri/src/lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_configurate::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### JavaScript / TypeScript

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

## Permissions

Add plugin permissions in your capability file:

```json
{
  "permissions": ["configurate:default"]
}
```

`configurate:default` includes:

- `configurate:allow-create`
- `configurate:allow-load`
- `configurate:allow-save`
- `configurate:allow-delete`
- `configurate:allow-load-all`
- `configurate:allow-save-all`
- `configurate:allow-unlock`

## Usage

### 1. Define schema

```ts
import { defineConfig, keyring } from "tauri-plugin-configurate-api";

const appSchema = defineConfig({
  theme: String,
  language: String,
  database: {
    host: String,
    password: keyring(String, { id: "db-password" }),
  },
});
```

### 2. Create `Configurate`

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

### 3. Single-file operations

```ts
const KEYRING = { service: "my-app", account: "default" };

await config
  .create({
    theme: "dark",
    language: "ja",
    database: { host: "localhost", password: "secret" },
  })
  .lock(KEYRING)
  .run();

const locked = await config.load().run();
const unlocked = await config.load().unlock(KEYRING);

await config
  .save({
    theme: "light",
    language: "en",
    database: { host: "db.example.com", password: "next-secret" },
  })
  .lock(KEYRING)
  .run();

await config.delete(KEYRING);
```

### 4. Provider examples

```ts
import {
  JsonProvider,
  YmlProvider,
  BinaryProvider,
  SqliteProvider,
} from "tauri-plugin-configurate-api";

JsonProvider();
YmlProvider();
BinaryProvider({ encryptionKey: "high-entropy-key" });
SqliteProvider({ dbName: "configurate.db", tableName: "configurate_configs" });
```

### 5. Batch operations

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

loaded.results.app;
saved.results.secret;
```

`run()` return shape:

```ts
{
  results: {
    [id: string]:
      | { ok: true; data: unknown }
      | { ok: false; error: { kind: string; message: string } };
  };
}
```

## Compatibility (one minor)

The following are still accepted for one minor release and normalized to new API:

- `new Configurate(schema, opts)`
- `ConfigurateFactory`
- `dir`, `name`, `path`, `format`, `encryptionKey`

Each deprecated path emits one warning per process.
