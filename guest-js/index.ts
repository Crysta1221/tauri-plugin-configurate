import { invoke } from "@tauri-apps/api/core";
export { BaseDirectory } from "@tauri-apps/api/path";
import type { BaseDirectory } from "@tauri-apps/api/path";

// ---------------------------------------------------------------------------
// Storage format
// ---------------------------------------------------------------------------

/** Supported on-disk storage formats **/
export type StorageFormat = "json" | "yaml" | "binary";

// ---------------------------------------------------------------------------
// Keyring marker types
// ---------------------------------------------------------------------------

/**
 * Brand key used to tag keyring-protected fields at runtime.
 *
 * A plain string property is used instead of a `Symbol` because some bundlers
 * (Vite / esbuild pre-bundling) incorrectly hoist computed `Symbol` property
 * keys out of scope, causing `_keyringBrand is not defined` errors at runtime.
 *
 * The string is long and namespaced to avoid accidental collisions with
 * user-defined keys.
 */
const KEYRING_BRAND_KEY = "__configurate_keyring__" as const;

/** Phantom symbol used only in the type system – never appears at runtime. */
declare const _keyringBrandTag: unique symbol;

/**
 * Marker type produced by `keyring()`.
 * `T`  – the runtime type of the secret value.
 * `Id` – the literal string id used to key the OS keyring entry.
 */
export type KeyringField<T, Id extends string> = {
  readonly [_keyringBrandTag]?: true;
  readonly _type: T;
  readonly _id: Id;
};

/** Options required when creating a keyring-protected field definition. */
export interface KeyringFieldOptions<Id extends string> {
  /** Unique identifier for this keyring entry. Must be unique within a schema. */
  id: Id;
}

/**
 * Marks a schema field as keyring-protected.
 *
 * @example
 * ```ts
 * const schema = defineConfig({
 *   apiKey: keyring(String, { id: "api-key" }),
 * });
 * ```
 */
export function keyring<T, Id extends string>(
  _type: abstract new (...args: never[]) => T | ((...args: never[]) => T),
  opts: KeyringFieldOptions<Id>,
): KeyringField<T, Id> {
  // Avoid computed property key syntax `{ [KEYRING_BRAND_KEY]: true }` in an
  // object literal.  Some bundlers (Vite / esbuild pre-bundling) incorrectly
  // hoist the evaluated key expression out of the enclosing function scope,
  // producing a "X is not defined" ReferenceError at runtime.
  // Assigning via bracket notation after construction is semantically
  // identical but is never subject to that hoisting behaviour.
  const field = { _type: undefined as unknown as T, _id: opts.id } as Record<
    string,
    unknown
  >;
  field[KEYRING_BRAND_KEY] = true;
  return field as KeyringField<T, Id>;
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

/** Primitive constructor types supported in a schema definition. */
type PrimitiveConstructor =
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor;

/** Maps a primitive constructor to its corresponding TS type. */
type InferPrimitive<C> = C extends StringConstructor
  ? string
  : C extends NumberConstructor
    ? number
    : C extends BooleanConstructor
      ? boolean
      : never;

/** Any value that is valid inside a schema definition. */
export type SchemaValue =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject;

/** A plain object whose values are all `SchemaValue`s. */
export type SchemaObject = { [key: string]: SchemaValue };

// ---------------------------------------------------------------------------
// Collect all keyring ids from a schema (used for duplicate detection)
// ---------------------------------------------------------------------------

/**
 * Recursively collects every keyring id found anywhere inside a schema as a
 * union of string literals.
 */
export type CollectKeyringIds<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<unknown, infer Id>
    ? Id
    : S[K] extends SchemaObject
      ? CollectKeyringIds<S[K]>
      : never;
}[keyof S];

/**
 * Produces `never` when a string literal `T` appears more than once inside
 * the union `All`. Used to detect duplicate keyring ids at compile time.
 *
 * The check works by removing `T` from `All` and seeing whether there are
 * still members left that match `T`.  If after exclusion some member equals
 * `T`, it means the original union contained `T` at least twice.
 */
type IsDuplicate<T extends string, All extends string> =
  T extends Exclude<All, T> ? true : false;

/**
 * Evaluates to `true` if any keyring id appears more than once in the
 * schema, `false` otherwise.
 */
export type HasDuplicateKeyringIds<S extends SchemaObject> = true extends {
  [Id in CollectKeyringIds<S>]: IsDuplicate<Id, CollectKeyringIds<S>>;
}[CollectKeyringIds<S>]
  ? true
  : false;

// ---------------------------------------------------------------------------
// Infer locked / unlocked config types from a schema
// ---------------------------------------------------------------------------

/**
 * Converts a schema into the "locked" config type where every
 * `KeyringField<T, Id>` becomes `null`.
 */
export type InferLocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<unknown, string>
    ? null
    : S[K] extends SchemaObject
      ? InferLocked<S[K]>
      : S[K] extends PrimitiveConstructor
        ? InferPrimitive<S[K]>
        : never;
};

/**
 * Converts a schema into the "unlocked" config type where every
 * `KeyringField<T, Id>` is replaced with the actual secret type `T`.
 */
export type InferUnlocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<infer T, string>
    ? T
    : S[K] extends SchemaObject
      ? InferUnlocked<S[K]>
      : S[K] extends PrimitiveConstructor
        ? InferPrimitive<S[K]>
        : never;
};

// ---------------------------------------------------------------------------
// Keyring options
// ---------------------------------------------------------------------------

/**
 * Options required to access the OS keyring.
 * Stored with OS keyring fields:
 * - service = `{service}`
 * - user    = `{account}/{id}`
 */
export interface KeyringOptions {
  /** The keyring service name (e.g. your application name). */
  service: string;
  /** The keyring account name (e.g. `"default"`). */
  account: string;
}

// ---------------------------------------------------------------------------
// Internal runtime helpers
// ---------------------------------------------------------------------------

/** Runtime check: is this value a KeyringField marker? */
function isKeyringField(
  val: SchemaValue,
): val is KeyringField<unknown, string> {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<string, unknown>)[KEYRING_BRAND_KEY] === true
  );
}

/** Runtime check: is this value a nested SchemaObject? */
function isSchemaObject(val: SchemaValue): val is SchemaObject {
  return typeof val === "object" && val !== null && !isKeyringField(val);
}

/**
 * Recursively collects all keyring ids from a schema as a flat string array.
 * Used for runtime duplicate validation.
 */
function collectKeyringIds(schema: SchemaObject): string[] {
  const ids: string[] = [];
  for (const val of Object.values(schema)) {
    if (isKeyringField(val)) {
      ids.push(val._id);
    } else if (isSchemaObject(val)) {
      ids.push(...collectKeyringIds(val));
    }
  }
  return ids;
}

/**
 * Recursively collects all keyring entries as `{ id, dotpath }` pairs.
 * `dotpath` is the dot-separated path to the field inside the config object.
 */
function collectKeyringPaths(
  schema: SchemaObject,
  prefix = "",
): { id: string; dotpath: string }[] {
  const result: { id: string; dotpath: string }[] = [];
  for (const [key, val] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isKeyringField(val)) {
      result.push({ id: val._id, dotpath: path });
    } else if (isSchemaObject(val)) {
      result.push(...collectKeyringPaths(val, path));
    }
  }
  return result;
}

/**
 * Separates a data object into non-secret plain fields and keyring entries.
 * Secret values are extracted from their dotpath locations and serialized to
 * strings so the Rust side can store them in the OS keyring.
 * The corresponding dotpath in `plain` is set to `null` so secrets are never
 * persisted to disk.
 */
function separateSecrets(
  data: Record<string, unknown>,
  keyringPaths: { id: string; dotpath: string }[],
): {
  plain: Record<string, unknown>;
  keyringEntries: Array<{ id: string; dotpath: string; value: string }>;
} {
  const plain = structuredClone(data) as Record<string, unknown>;
  const keyringEntries: Array<{ id: string; dotpath: string; value: string }> =
    [];

  for (const { id, dotpath } of keyringPaths) {
    const parts = dotpath.split(".");
    let node: unknown = plain;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node === null || typeof node !== "object") break;
      node = (node as Record<string, unknown>)[parts[i] ?? ""];
    }
    const last = parts.at(-1) ?? "";
    // Guard: after traversal node must still be a plain object.
    if (node === null || typeof node !== "object") continue;
    const parent = node as Record<string, unknown>;
    if (last in parent) {
      const secret = parent[last];
      const serialized =
        typeof secret === "string" ? secret : JSON.stringify(secret);
      keyringEntries.push({ id, dotpath, value: serialized });
      // Nullify the secret in the plain data so it is never written to disk.
      parent[last] = null;
    }
  }

  return { plain, keyringEntries };
}

// ---------------------------------------------------------------------------
// LockedConfig
// ---------------------------------------------------------------------------

/**
 * A loaded configuration where keyring-protected fields are `null`.
 * Call `.unlock(opts)` to fetch secrets and obtain an `UnlockedConfig<S>`.
 *
 * `unlock()` issues a single IPC call that only reads from the OS keyring —
 * it does **not** re-read the file from disk.
 */
export class LockedConfig<S extends SchemaObject> {
  readonly data: InferLocked<S>;

  /** @internal */
  constructor(
    data: InferLocked<S>,
    private readonly _configurate: Configurate<S>,
  ) {
    this.data = data;
  }

  /**
   * Fetches all keyring secrets and returns an `UnlockedConfig`.
   * Issues a single IPC call (keyring read only – file is not re-read).
   */
  async unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._unlockFromData(
      this.data as Record<string, unknown>,
      opts,
    );
  }
}

// ---------------------------------------------------------------------------
// UnlockedConfig
// ---------------------------------------------------------------------------

/**
 * A configuration where all keyring-protected fields contain their real values.
 * Call `.lock()` to discard in-memory secrets (no IPC required).
 */
export class UnlockedConfig<S extends SchemaObject> {
  private _data: InferUnlocked<S> | null;

  /** @internal */
  constructor(data: InferUnlocked<S>) {
    this._data = data;
  }

  /**
   * Returns the unlocked configuration data.
   * Throws if `lock()` has already been called.
   */
  get data(): InferUnlocked<S> {
    if (this._data === null) {
      throw new Error(
        "Cannot access data after lock() has been called. " +
          "Load or unlock the config again to get a fresh instance.",
      );
    }
    return this._data;
  }

  /**
   * Discards in-memory secrets. Callers should drop all references to this
   * object after calling `lock()`.
   *
   * > **Security note** — JavaScript does not provide a guaranteed way to
   * > zero-out memory. Calling `lock()` nullifies the top-level reference
   * > but the secret values remain in the JS heap until the GC collects them.
   * > Avoid long-lived `UnlockedConfig` objects when handling sensitive data.
   */
  lock(): void {
    this._data = null;
  }
}

// ---------------------------------------------------------------------------
// LazyConfigEntry
// ---------------------------------------------------------------------------

/**
 * A lazy handle returned by `Configurate.load()`, `.create()` and `.save()`.
 *
 * - `await entry.run()` → `LockedConfig<S>` (one IPC, secrets are null)
 * - `await entry.unlock(opts)` → `UnlockedConfig<S>` (one IPC, secrets inlined)
 * - `.lock(opts)` (before awaiting) → write secrets to keyring in the same IPC
 *
 * Use `await entry.run()` instead of `await entry` directly to avoid the
 * `no-thenable` lint rule and unintended Promise behaviour.
 */
export class LazyConfigEntry<S extends SchemaObject> {
  private _keyringOpts: KeyringOptions | null = null;

  /** @internal */
  constructor(
    private readonly _configurate: Configurate<S>,
    private readonly _op: "create" | "load" | "save",
    private readonly _data?: InferUnlocked<S>,
  ) {}

  /**
   * Attaches keyring options so secrets are written to / read from the OS
   * keyring in the same IPC call as the main operation.
   *
   * Returns `this` to allow chaining: `entry.lock(opts).run()`.
   */
  lock(opts: KeyringOptions): this {
    this._keyringOpts = opts;
    return this;
  }

  /**
   * Executes the operation and returns a `LockedConfig` (secrets are null).
   * Issues a single IPC call.
   */
  run(): Promise<LockedConfig<S>> {
    return this._configurate._executeLocked(
      this._op,
      this._data,
      this._keyringOpts,
    );
  }

  /**
   * Executes the operation and returns an `UnlockedConfig` (secrets inlined).
   * Issues a single IPC call – no extra round-trip compared to `run()`.
   */
  unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._executeUnlock(this._op, this._data, opts);
  }
}

// ---------------------------------------------------------------------------
// Configurate class
// ---------------------------------------------------------------------------

/**
 * Base options shared across all configs created by a `ConfigurateFactory`.
 * `name` is omitted because each config provides its own filename.
 *
 * `dirName` replaces the app identifier component of the base path.
 * `path` adds a sub-directory within the root (after `dirName` / identifier).
 */
export interface ConfigurateBaseOptions {
  /** Base directory in which the configuration file will be stored. */
  dir: BaseDirectory;
  /**
   * Optional replacement for the app identifier directory.
   *
   * When provided, **replaces** the identifier component of the resolved base path.
   * For example, with `BaseDirectory.AppConfig` on Windows:
   *
   * | `dirName`    | Resolved root                        |
   * | ------------ | ------------------------------------ |
   * | _(omitted)_  | `%APPDATA%/com.example.app/`         |
   * | `"my-app"`   | `%APPDATA%/my-app/`                  |
   * | `"org/app"`  | `%APPDATA%/org/app/`                 |
   *
   * Each segment is validated on the Rust side; `..` and Windows-forbidden
   * characters are rejected.
   */
  dirName?: string;
  /**
   * Optional sub-directory within the root (after `dirName` / identifier is applied).
   *
   * Use forward slashes to create nested directories (e.g. `"config/v2"`).
   * Each segment is validated on the Rust side; `..` and Windows-forbidden
   * characters are rejected.
   *
   * ### Path layout
   *
   * | `dirName`   | `path`      | Resolved path (AppConfig, identifier `com.example.app`)  |
   * | ----------- | ----------- | --------------------------------------------------------- |
   * | _(omitted)_ | _(omitted)_ | `%APPDATA%/com.example.app/<name>`                        |
   * | `"my-app"`  | _(omitted)_ | `%APPDATA%/my-app/<name>`                                 |
   * | _(omitted)_ | `"cfg/v2"`  | `%APPDATA%/com.example.app/cfg/v2/<name>`                 |
   * | `"my-app"`  | `"cfg/v2"`  | `%APPDATA%/my-app/cfg/v2/<name>`                          |
   */
  path?: string;
  /** On-disk storage format. */
  format: StorageFormat;
  /**
   * Encryption key for the `"binary"` format.
   *
   * When provided, the file is encrypted with **XChaCha20-Poly1305**. The
   * 32-byte cipher key is derived internally via `SHA-256(encryptionKey)`, so
   * the value should be high-entropy — for example a random key stored in the
   * OS keyring. Omit this field when using `"json"` or `"yaml"` formats, or
   * when backward-compatible unencrypted binary files are required.
   *
   * Encrypted binary files use the `.binc` extension instead of `.bin`.
   */
  encryptionKey?: string;
}

/** Options passed to the `Configurate` constructor. */
export interface ConfigurateOptions extends ConfigurateBaseOptions {
  /**
   * Full filename for the configuration file, including extension.
   *
   * Examples: `"app.json"`, `"data.yaml"`, `"settings.binc"`, `".env"`.
   *
   * Must be a single path component — path separators (`/`, `\`) are rejected
   * by the Rust side. Use the `path` option to store files in a sub-directory.
   */
  name: string;
}

/**
 * Main entry point for managing application configuration.
 *
 * @example
 * ```ts
 * import { Configurate, defineConfig, keyring, BaseDirectory } from "tauri-plugin-configurate-api";
 *
 * const schema = defineConfig({
 *   appName: String,
 *   port: Number,
 *   apiKey: keyring(String, { id: "api-key" }),
 * });
 *
 * const config = new Configurate(schema, {
 *   name: "app-config.json",
 *   dir: BaseDirectory.AppConfig,
 *   format: "json",
 * });
 *
 * // Create – IPC ×1
 * await config
 *   .create({ appName: "MyApp", port: 3000, apiKey: "secret" })
 *   .lock({ service: "my-app", account: "default" })
 *   .run();
 *
 * // Load locked – IPC ×1
 * const locked = await config.load().run();
 * locked.data.apiKey; // null
 *
 * // Unlock from locked – IPC ×1 (keyring only, file is not re-read)
 * const unlocked = await locked.unlock({ service: "my-app", account: "default" });
 * unlocked.data.apiKey; // "secret"
 *
 * // Load and unlock in one shot – IPC ×1
 * const unlocked2 = await config.load().unlock({ service: "my-app", account: "default" });
 * ```
 */
export class Configurate<S extends SchemaObject> {
  private readonly _schema: S;
  private readonly _opts: ConfigurateOptions;
  private readonly _keyringPaths: { id: string; dotpath: string }[];

  constructor(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    opts: ConfigurateOptions,
  ) {
    if (opts.encryptionKey !== undefined && opts.format !== "binary") {
      throw new Error(
        `encryptionKey is only supported with format "binary", got "${opts.format}". ` +
          `Remove encryptionKey or change format to "binary".`,
      );
    }
    if (!opts.name) {
      throw new Error('Configurate: "name" must not be empty.');
    }
    if (opts.name.includes("/") || opts.name.includes("\\")) {
      throw new Error(
        'Configurate: "name" must be a single filename and cannot contain path separators.',
      );
    }
    if (opts.name === "." || opts.name === "..") {
      throw new Error('Configurate: "name" must not be "." or "..".');
    }
    if (opts.dirName !== undefined) {
      const dirNameSegments = opts.dirName.split(/[/\\]/);
      if (
        dirNameSegments.some((seg) => seg === "" || seg === "." || seg === "..")
      ) {
        throw new Error(
          'Configurate: "dirName" must not contain empty or special segments.',
        );
      }
    }
    if (opts.path !== undefined) {
      const pathSegments = opts.path.split(/[/\\]/);
      if (
        pathSegments.some((seg) => seg === "" || seg === "." || seg === "..")
      ) {
        throw new Error(
          'Configurate: "path" must not contain empty or special segments.',
        );
      }
    }
    this._schema = schema as unknown as S;
    this._opts = opts;
    this._keyringPaths = collectKeyringPaths(this._schema);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns a lazy entry that creates the config file on the Rust side. */
  create(data: InferUnlocked<S>): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "create", data);
  }

  /** Returns a lazy entry that loads the config file from the Rust side. */
  load(): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "load");
  }

  /** Returns a lazy entry that overwrites the config file on the Rust side. */
  save(data: InferUnlocked<S>): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "save", data);
  }

  /**
   * Deletes the configuration file from disk **and** removes all associated
   * keyring entries from the OS keyring in a single IPC call.
   *
   * Pass `opts` when the schema contains `keyring()` fields so the plugin
   * knows which keyring entries to wipe. Omit `opts` (or pass `null`) when
   * the schema has no keyring fields.
   *
   * Returns `Promise<void>`. Resolves even if the file did not exist.
   *
   * @example
   * ```ts
   * // Schema with keyring fields – pass keyring opts to wipe secrets too.
   * await config.delete({ service: "my-app", account: "default" });
   *
   * // Schema with no keyring fields – opts may be omitted.
   * await config.delete();
   * ```
   */
  async delete(opts?: KeyringOptions | null): Promise<void> {
    const payload = this._buildPayload("load", undefined, opts ?? null, false);
    await invoke("plugin:configurate|delete", { payload });
  }

  // -------------------------------------------------------------------------
  // Internal helpers (called by LazyConfigEntry / LockedConfig)
  // -------------------------------------------------------------------------

  /** @internal */
  async _executeLocked(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions | null,
  ): Promise<LockedConfig<S>> {
    const payload = this._buildPayload(op, data, keyringOpts, false);
    const result = await invoke<InferLocked<S>>("plugin:configurate|" + op, {
      payload,
    });
    return new LockedConfig(result, this);
  }

  /** @internal */
  async _executeUnlock(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    const payload = this._buildPayload(op, data, keyringOpts, true);
    const result = await invoke<InferUnlocked<S>>("plugin:configurate|" + op, {
      payload,
    });
    return new UnlockedConfig(result);
  }

  /**
   * Fetches keyring secrets and merges them into already-loaded plain data
   * without re-reading the file from disk.
   * Issues a single IPC call to `plugin:configurate|unlock`.
   *
   * @internal
   */
  async _unlockFromData(
    plainData: Record<string, unknown>,
    opts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    if (this._keyringPaths.length === 0) {
      return new UnlockedConfig(plainData as InferUnlocked<S>);
    }
    const payload = {
      data: plainData,
      keyringEntries: this._keyringPaths.map(({ id, dotpath }) => ({
        id,
        dotpath,
        value: "",
      })),
      keyringOptions: opts,
    };
    const result = await invoke<InferUnlocked<S>>("plugin:configurate|unlock", {
      payload,
    });
    return new UnlockedConfig(result);
  }

  // -------------------------------------------------------------------------
  // Payload builder
  // -------------------------------------------------------------------------

  /** @internal */
  _buildPayload(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions | null,
    withUnlock: boolean,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: this._opts.name,
      dir: this._opts.dir as number,
      format: this._opts.format,
      withUnlock,
    };

    if (this._opts.dirName !== undefined) {
      base.dirName = this._opts.dirName;
    }

    if (this._opts.path !== undefined) {
      base.path = this._opts.path;
    }

    if (this._opts.encryptionKey) {
      base.encryptionKey = this._opts.encryptionKey;
    }

    if (op === "load") {
      // For load we only need the keyring ids and dotpaths so the Rust side
      // knows which dotpaths to populate when with_unlock is true.
      if (keyringOpts && this._keyringPaths.length > 0) {
        base.keyringEntries = this._keyringPaths.map(({ id, dotpath }) => ({
          id,
          dotpath,
          value: "",
        }));
        base.keyringOptions = keyringOpts;
      }
    } else if (data !== undefined) {
      const { plain, keyringEntries } = separateSecrets(
        data as Record<string, unknown>,
        this._keyringPaths,
      );
      base.data = plain;
      if (keyringOpts && keyringEntries.length > 0) {
        base.keyringEntries = keyringEntries;
        base.keyringOptions = keyringOpts;
      }
    }

    return base;
  }
}

// ---------------------------------------------------------------------------
// ConfigurateFactory
// ---------------------------------------------------------------------------

/**
 * Object form accepted by `ConfigurateFactory.build()` as the second argument.
 *
 * - `name` — filename (may include a relative path, e.g. `"config/state.bin"`)
 * - `path` — sub-directory appended after the root / `dirName`; `null` disables the factory-level value
 * - `dirName` — replaces the app identifier segment; `null` disables the factory-level value
 */
export interface BuildConfig {
  /** Filename including extension. May contain `/`-separated path segments (e.g. `"config/state.bin"`). */
  name: string;
  /** Optional sub-directory within the root. Pass `null` to disable the factory-level value. */
  path?: string | null;
  /** Optional replacement for the app identifier directory. Pass `null` to disable the factory-level value. */
  dirName?: string | null;
}

/**
 * A factory that creates `Configurate` instances with pre-set shared options
 * (`dir`, `format`, and optionally `dirName`, `path`, `encryptionKey`).
 *
 * Each call to `build()` creates a fresh `Configurate` instance — schema,
 * `name`, and all other options can differ freely.  This is the recommended
 * way to manage multiple config files with different schemas in a single
 * application.
 *
 * @example
 * ```ts
 * import { ConfigurateFactory, defineConfig, BaseDirectory } from "tauri-plugin-configurate-api";
 *
 * const appSchema   = defineConfig({ theme: String, language: String });
 * const cacheSchema = defineConfig({ lastSync: Number });
 * const secretSchema = defineConfig({ token: String });
 *
 * const factory = new ConfigurateFactory({
 *   dir: BaseDirectory.AppConfig,
 *   format: "json",
 * });
 *
 * const appConfig    = factory.build(appSchema,    "app.json");                                     // → app.json
 * const cacheConfig  = factory.build(cacheSchema,  "cache.json");                                   // → cache.json
 * const nestedConfig = factory.build(appSchema, { name: "app.json", path: "config" });              // → config/app.json
 * const movedConfig  = factory.build(appSchema, { name: "app.json", dirName: "my-app" });           // → %APPDATA%/my-app/app.json
 * const fullConfig   = factory.build(appSchema, { name: "app.json", dirName: "my-app", path: "cfg" }); // → %APPDATA%/my-app/cfg/app.json
 * ```
 */
export class ConfigurateFactory {
  constructor(private readonly _baseOpts: ConfigurateBaseOptions) {}

  /**
   * Creates a `Configurate<S>` for the given schema, applying the shared base
   * options.
   *
   * `nameOrConfig` accepts either:
   * - a plain `string` — used as the full filename (e.g. `"app.json"`, `".env"`)
   * - `{ name: string; path?: string | null; dirName?: string | null }` — explicitly
   *   provides the filename, optional sub-directory within the root, and optional
   *   identifier replacement
   *
   * In the object form, passing `null` for `dirName` or `path` explicitly
   * disables the factory-level value. Omitting the field (or passing
   * `undefined`) falls back to the factory-level value.
   *
   * The optional third `dirName` string overrides the factory-level `dirName`
   * for this instance (only used when `nameOrConfig` is a plain string).
   *
   * ### Path layout (AppConfig, identifier `com.example.app`)
   *
   * | `nameOrConfig`                                   | `dirName` arg | Resolved path                                  |
   * | ------------------------------------------------ | ------------- | ---------------------------------------------- |
   * | `"app.json"`                                     | _(omitted)_   | `%APPDATA%/com.example.app/app.json`           |
   * | `"app.json"`                                     | `"my-app"`    | `%APPDATA%/my-app/app.json`                    |
   * | `{ name: "app.json", path: "cfg" }`              | _(omitted)_   | `%APPDATA%/com.example.app/cfg/app.json`       |
   * | `{ name: "app.json", dirName: "my-app" }`        | _(omitted)_   | `%APPDATA%/my-app/app.json`                    |
   * | `{ name: "app.json", dirName: "my-app", path: "cfg" }` | _(omitted)_ | `%APPDATA%/my-app/cfg/app.json`          |
   *
   * @example
   * ```ts
   * factory.build(schema, "app.json")                                              // → <root>/app.json
   * factory.build(schema, "app.json", "my-app")                                   // → %APPDATA%/my-app/app.json
   * factory.build(schema, { name: "app.json", path: "config" })                   // → <root>/config/app.json
   * factory.build(schema, { name: "app.json", dirName: "my-app" })                // → %APPDATA%/my-app/app.json
   * factory.build(schema, { name: "cfg.json", dirName: "my-app", path: "a/b" })   // → %APPDATA%/my-app/a/b/cfg.json
   * ```
   */
  build<S extends SchemaObject>(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    name: string,
    dirName?: string,
  ): Configurate<S>;
  build<S extends SchemaObject>(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    config: BuildConfig,
  ): Configurate<S>;
  build<S extends SchemaObject>(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    nameOrConfig: string | BuildConfig,
    dirName?: string,
  ): Configurate<S> {
    let fileName: string;
    let resolvedDirName: string | undefined;
    let resolvedPath: string | undefined;

    if (typeof nameOrConfig === "string") {
      fileName = nameOrConfig;
      // The explicit `dirName` argument overrides the factory-level dirName;
      // fall back to the factory-level dirName when omitted.
      resolvedDirName = dirName ?? this._baseOpts.dirName;
      resolvedPath = this._baseOpts.path;
    } else {
      fileName = nameOrConfig.name;
      // Object form: fields inside take precedence over factory-level values.
      // Pass `null` to explicitly disable the factory-level value;
      // `undefined` (or omitted) falls back to the factory-level value.
      resolvedDirName =
        nameOrConfig.dirName === null
          ? undefined
          : (nameOrConfig.dirName ?? this._baseOpts.dirName);
      resolvedPath =
        nameOrConfig.path === null
          ? undefined
          : (nameOrConfig.path ?? this._baseOpts.path);
    }

    const opts: ConfigurateOptions = {
      ...this._baseOpts,
      name: fileName,
      dirName: resolvedDirName,
      path: resolvedPath,
    };

    // Explicitly pass <S> to prevent TypeScript from re-inferring the type
    // parameter from the argument and double-evaluating HasDuplicateKeyringIds
    // on the already-constrained type.  The duplicate-id guarantee was already
    // enforced at the call-site when the schema was created.
    return new Configurate<S>(
      schema as unknown as S &
        (true extends HasDuplicateKeyringIds<S> ? never : unknown),
      opts,
    );
  }
}

// ---------------------------------------------------------------------------
// defineConfig helper
// ---------------------------------------------------------------------------

/**
 * Defines a configuration schema. Provides a convenient declaration site and
 * compile-time duplicate keyring id checks.
 *
 * @example
 * ```ts
 * const schema = defineConfig({
 *   appName: String,
 *   port: Number,
 *   database: {
 *     host: String,
 *     password: keyring(String, { id: "db-password" }),
 *   },
 * });
 * ```
 */
export function defineConfig<S extends SchemaObject>(
  schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
): S {
  // Runtime duplicate id validation (belt-and-suspenders on top of type checks).
  const ids = collectKeyringIds(schema as SchemaObject);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `Duplicate keyring id: '${id}'. Each keyring() call must use a unique id within the same schema.`,
      );
    }
    seen.add(id);
  }
  return schema as S;
}
