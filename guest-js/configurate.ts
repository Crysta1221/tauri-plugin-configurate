import { invoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
export { BaseDirectory } from "@tauri-apps/api/path";
import type { BaseDirectory } from "@tauri-apps/api/path";
import {
  CONFIGURATE_VERSION_KEY,
  isPlainObject,
  validateSchemaArrays,
  hasAnyKeyring,
  hasArrayKeyring,
  collectStaticKeyringPaths,
  collectKeyringReadEntries,
  separateSecrets,
  collectSqliteColumns,
  assertDataMatchesSchema,
  assertPartialDataMatchesSchema,
  deepMergeDefaults,
  applyMigrations,
  assertNonEmptyId,
  toBatchError,
} from "./schema-utils";
import type { SqliteColumn } from "./schema-utils";
import type {
  HasDuplicateKeyringIds,
  InferLocked,
  InferUnlocked,
  MigrationStep,
  SchemaObject,
} from "./schema";
import { isProvider } from "./provider";
import type { ConfigurateProvider } from "./provider";

// ---------------------------------------------------------------------------
// Keyring options
// ---------------------------------------------------------------------------

export interface KeyringOptions {
  service: string;
  account: string;
}

// ---------------------------------------------------------------------------
// Config objects
// ---------------------------------------------------------------------------

export interface ConfiguratePathOptions {
  dirName?: string;
  currentPath?: string;
}

export interface SchemaValidationOptions {
  /** Validate payload data against schema before create/save. Default: false */
  validateOnWrite?: boolean;
  /** Validate loaded data against schema after load/unlock. Default: false */
  validateOnRead?: boolean;
  /** Allow keys not declared in schema objects. Default: false */
  allowUnknownKeys?: boolean;
}

// MigrationStep is defined in schema.ts and re-exported via index.ts.
export type { MigrationStep } from "./schema";

export interface ConfigurateInit<S extends SchemaObject> {
  schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown);
  fileName: string;
  baseDir: BaseDirectory;
  provider: ConfigurateProvider;
  options?: ConfiguratePathOptions;
  validation?: SchemaValidationOptions;
  /** Default values to fill in when loading a config with missing keys. */
  defaults?: Partial<InferUnlocked<S>>;
  /** Current schema version. When set, a `__configurate_version__` field is stored in the data. */
  version?: number;
  /** Ordered list of migration steps to apply when loading older configs. */
  migrations?: MigrationStep<InferUnlocked<S> & Record<string, unknown>>[];
}

interface ResolvedSchemaValidationOptions {
  validateOnWrite: boolean;
  validateOnRead: boolean;
  allowUnknownKeys: boolean;
}

interface NormalizedConfigurateInit<S extends SchemaObject> {
  schema: S;
  fileName: string;
  baseDir: BaseDirectory;
  provider: ConfigurateProvider;
  options?: ConfiguratePathOptions;
  validation: ResolvedSchemaValidationOptions;
  defaults?: Partial<InferUnlocked<S>>;
  version?: number;
  migrations?: MigrationStep<InferUnlocked<S> & Record<string, unknown>>[];
}

function resolveValidationOptions(
  options: SchemaValidationOptions | undefined,
): ResolvedSchemaValidationOptions {
  return {
    validateOnWrite: options?.validateOnWrite ?? false,
    validateOnRead: options?.validateOnRead ?? false,
    allowUnknownKeys: options?.allowUnknownKeys ?? false,
  };
}

function normalizeConfigurateInit<S extends SchemaObject>(
  input: ConfigurateInit<S>,
): NormalizedConfigurateInit<S> {
  const schema = input.schema;

  const fileName = input.fileName;
  if (!fileName) {
    throw new Error('Configurate: "fileName" must be provided.');
  }

  const baseDir = input.baseDir;
  if (baseDir === undefined) {
    throw new Error('Configurate: "baseDir" must be provided.');
  }

  const provider = input.provider;
  if (!isProvider(provider)) {
    throw new Error(
      "Configurate: provider must be created by JsonProvider/YmlProvider/BinaryProvider/SqliteProvider.",
    );
  }

  if (fileName.includes("/") || fileName.includes("\\")) {
    throw new Error(
      'Configurate: "fileName" must be a single filename and cannot contain path separators.',
    );
  }
  if (fileName === "." || fileName === "..") {
    throw new Error('Configurate: "fileName" must not be "." or "..".');
  }

  if (input.options?.dirName !== undefined) {
    const segments = input.options.dirName.split(/[\\/]/);
    if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new Error(
        'Configurate: "options.dirName" must not contain empty or special segments.',
      );
    }
  }
  if (input.options?.currentPath !== undefined) {
    const segments = input.options.currentPath.split(/[\\/]/);
    if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new Error(
        'Configurate: "options.currentPath" must not contain empty or special segments.',
      );
    }
  }

  return {
    schema,
    fileName,
    baseDir,
    provider,
    options:
      input.options?.dirName || input.options?.currentPath
        ? input.options
        : undefined,
    validation: resolveValidationOptions(input.validation),
    defaults: input.defaults,
    version: input.version,
    migrations: input.migrations,
  };
}

function buildChangeTargetId(
  init: Pick<
    NormalizedConfigurateInit<SchemaObject>,
    "fileName" | "baseDir" | "provider" | "options"
  >,
): string {
  const dbName =
    init.provider.kind === "sqlite" ? (init.provider.dbName ?? "") : "";
  const tableName =
    init.provider.kind === "sqlite" ? (init.provider.tableName ?? "") : "";

  return [
    JSON.stringify(init.baseDir),
    init.provider.kind,
    init.fileName,
    init.options?.dirName ?? "",
    init.options?.currentPath ?? "",
    dbName,
    tableName,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type BatchRunEntryResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { kind: string; message: string } };

export interface BatchRunResult {
  results: Record<string, BatchRunEntryResult>;
}

interface BatchConfigLike {
  _buildPayload(
    op: "create" | "load" | "save" | "patch" | "delete",
    data: unknown,
    keyringOpts: KeyringOptions | null,
    withUnlock: boolean,
    returnData?: boolean,
  ): Record<string, unknown>;
  _attachFullReplaceKeyringDeletes(
    payload: Record<string, unknown>,
    keyringOpts: KeyringOptions | null,
  ): Promise<void>;
  _postProcessLoadedData(data: unknown): Promise<unknown>;
  _validateLoadedData(data: unknown): void;
  _unlockLoadedData(
    data: unknown,
    keyringOpts: KeyringOptions,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Locked/Unlocked entries
// ---------------------------------------------------------------------------

export class LockedConfig<S extends SchemaObject> {
  readonly data: InferLocked<S>;

  /** @internal */
  constructor(
    data: InferLocked<S>,
    private readonly _configurate: Configurate<S>,
  ) {
    this.data = data;
  }

  async unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._unlockFromData(
      this.data as Record<string, unknown>,
      opts,
    );
  }
}

export class PatchedConfig<S extends SchemaObject> {
  readonly data: Partial<InferLocked<S>>;

  /** @internal */
  constructor(data: Partial<InferLocked<S>>) {
    this.data = data;
  }
}

export class UnlockedConfig<S extends SchemaObject> {
  private _data: InferUnlocked<S> | null;

  /** @internal */
  constructor(data: InferUnlocked<S>) {
    this._data = data;
  }

  get data(): InferUnlocked<S> {
    if (this._data === null) {
      throw new Error(
        "Cannot access data after lock() has been called. Load or unlock again.",
      );
    }
    return this._data;
  }

  /**
   * Revokes access to the decrypted data through this instance.
   * After calling this method, accessing `data` will throw an error.
   *
   * NOTE: This does NOT zero-clear the underlying memory. JavaScript's garbage
   * collector manages memory reclamation and immediate clearing cannot be
   * guaranteed. Treat this as an API-level access guard, not a cryptographic wipe.
   */
  lock(): void {
    this._data = null;
  }
}

export class LazyConfigEntry<S extends SchemaObject> {
  private _keyringOpts: KeyringOptions | null = null;

  /** @internal */
  constructor(
    private readonly _configurate: Configurate<S>,
    private readonly _op: "create" | "load" | "save",
    private readonly _data?: InferUnlocked<S>,
  ) {}

  lock(opts: KeyringOptions): this {
    this._keyringOpts = opts;
    return this;
  }

  run(): Promise<LockedConfig<S>> {
    return this._configurate._executeLocked(
      this._op,
      this._data,
      this._keyringOpts,
    );
  }

  unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._executeUnlock(this._op, this._data, opts);
  }
}

export class LazyPatchEntry<S extends SchemaObject> {
  private _keyringOpts: KeyringOptions | null = null;
  private _createIfMissing = false;

  /** @internal */
  constructor(
    private readonly _configurate: Configurate<S>,
    private readonly _data: Partial<InferUnlocked<S>>,
  ) {}

  lock(opts: KeyringOptions): this {
    this._keyringOpts = opts;
    return this;
  }

  /**
   * When called, the patch will create the config with the provided partial
   * data if the config file does not yet exist, instead of throwing an error.
   *
   * @example
   * await config.patch({ theme: "dark" }).createIfMissing().run();
   */
  createIfMissing(): this {
    this._createIfMissing = true;
    return this;
  }

  run(): Promise<PatchedConfig<S>> {
    return this._configurate._executePatchLocked(
      this._data,
      this._keyringOpts,
      this._createIfMissing,
    );
  }

  unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._executePatchUnlock(
      this._data,
      opts,
      this._createIfMissing,
    );
  }
}

export class LazyResetEntry<S extends SchemaObject> {
  private _keyringOpts: KeyringOptions | null = null;

  /** @internal */
  constructor(
    private readonly _configurate: Configurate<S>,
    private readonly _data: InferUnlocked<S>,
  ) {}

  lock(opts: KeyringOptions): this {
    this._keyringOpts = opts;
    return this;
  }

  async run(): Promise<LockedConfig<S>> {
    return this._configurate._executeReset(this._data, this._keyringOpts);
  }

  async unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._executeResetUnlock(this._data, opts);
  }
}

// ---------------------------------------------------------------------------
// Batch builders
// ---------------------------------------------------------------------------

export interface LoadAllEntry {
  id: string;
  config: BatchConfigLike;
}

export interface SaveAllEntry {
  id: string;
  config: BatchConfigLike;
  data: unknown;
}

export interface LoadAllRunner {
  unlock(id: string, opts: KeyringOptions): LoadAllRunner;
  unlockAll(opts: KeyringOptions): LoadAllRunner;
  run(): Promise<BatchRunResult>;
}

export interface SaveAllRunner {
  lock(id: string, opts: KeyringOptions): SaveAllRunner;
  lockAll(opts: KeyringOptions): SaveAllRunner;
  run(): Promise<BatchRunResult>;
}

class LoadAllBuilder {
  private readonly _entries: LoadAllEntry[];
  private _unlockAll: KeyringOptions | null = null;
  private readonly _unlockById = new Map<string, KeyringOptions>();
  private readonly _idSet = new Set<string>();

  constructor(entries: LoadAllEntry[]) {
    if (entries.length === 0) {
      throw new Error("Configurate.loadAll requires at least one entry.");
    }

    for (const entry of entries) {
      assertNonEmptyId(this._idSet, entry.id);
    }
    this._entries = entries;
  }

  unlock(id: string, opts: KeyringOptions): this {
    if (!this._idSet.has(id)) {
      throw new Error(`Unknown id '${id}' passed to loadAll().unlock().`);
    }
    this._unlockById.set(id, opts);
    return this;
  }

  unlockAll(opts: KeyringOptions): this {
    this._unlockAll = opts;
    return this;
  }

  async run(): Promise<BatchRunResult> {
    const payload = {
      entries: this._entries.map((entry) => {
        return {
          id: entry.id,
          payload: entry.config._buildPayload("load", undefined, null, false),
        };
      }),
    };

    const batchResult = await invoke<BatchRunResult>(
      "plugin:configurate|load_all",
      { payload },
    );

    await Promise.all(
      this._entries.map(async (entry) => {
        const result = batchResult.results[entry.id];
        if (!result || !result.ok) {
          return;
        }

        try {
          result.data = await entry.config._postProcessLoadedData(result.data);
        } catch (error) {
          batchResult.results[entry.id] = {
            ok: false,
            error: toBatchError(error, "post_load_failed"),
          };
        }
      }),
    );

    for (const entry of this._entries) {
      const result = batchResult.results[entry.id];
      if (!result || !result.ok) {
        continue;
      }
      try {
        entry.config._validateLoadedData(result.data);
      } catch (error) {
        batchResult.results[entry.id] = {
          ok: false,
          error: toBatchError(error, "schema_validation"),
        };
      }
    }

    await Promise.all(
      this._entries.map(async (entry) => {
        const unlockOpts = this._unlockById.get(entry.id) ?? this._unlockAll;
        if (unlockOpts === null) {
          return;
        }

        const result = batchResult.results[entry.id];
        if (!result || !result.ok) {
          return;
        }

        try {
          const unlockedData = await entry.config._unlockLoadedData(
            result.data,
            unlockOpts,
          );
          batchResult.results[entry.id] = { ok: true, data: unlockedData };
        } catch (error) {
          batchResult.results[entry.id] = {
            ok: false,
            error: toBatchError(error, "unlock_failed"),
          };
        }
      }),
    );

    return batchResult;
  }
}

class SaveAllBuilder {
  private readonly _entries: SaveAllEntry[];
  private _lockAll: KeyringOptions | null = null;
  private readonly _lockById = new Map<string, KeyringOptions>();
  private readonly _idSet = new Set<string>();

  constructor(entries: SaveAllEntry[]) {
    if (entries.length === 0) {
      throw new Error("Configurate.saveAll requires at least one entry.");
    }

    for (const entry of entries) {
      assertNonEmptyId(this._idSet, entry.id);
    }
    this._entries = entries;
  }

  lock(id: string, opts: KeyringOptions): this {
    if (!this._idSet.has(id)) {
      throw new Error(`Unknown id '${id}' passed to saveAll().lock().`);
    }
    this._lockById.set(id, opts);
    return this;
  }

  lockAll(opts: KeyringOptions): this {
    this._lockAll = opts;
    return this;
  }

  async run(): Promise<BatchRunResult> {
    const payloadEntries: Array<{
      id: string;
      payload: Record<string, unknown>;
    }> = [];
    const preflightResults: Record<string, BatchRunEntryResult> = {};

    for (const entry of this._entries) {
      const lockOpts = this._lockById.get(entry.id) ?? this._lockAll;
      try {
        const entryPayload = entry.config._buildPayload(
          "save",
          entry.data as InferUnlocked<SchemaObject>,
          lockOpts,
          false,
          false,
        );
        await entry.config._attachFullReplaceKeyringDeletes(
          entryPayload,
          lockOpts,
        );
        payloadEntries.push({
          id: entry.id,
          payload: entryPayload,
        });
      } catch (error) {
        preflightResults[entry.id] = {
          ok: false,
          error: toBatchError(error, "payload_build_failed"),
        };
      }
    }

    if (payloadEntries.length === 0) {
      return { results: preflightResults };
    }

    const payload = { entries: payloadEntries };
    const backendResult = await invoke<BatchRunResult>(
      "plugin:configurate|save_all",
      { payload },
    );
    return {
      results: {
        ...backendResult.results,
        ...preflightResults,
      },
    };
  }
}

export interface PatchAllEntry {
  id: string;
  config: BatchConfigLike;
  data: unknown;
}

export interface PatchAllRunner {
  lock(id: string, opts: KeyringOptions): PatchAllRunner;
  lockAll(opts: KeyringOptions): PatchAllRunner;
  run(): Promise<BatchRunResult>;
}

class PatchAllBuilder {
  private readonly _entries: PatchAllEntry[];
  private _lockAll: KeyringOptions | null = null;
  private readonly _lockById = new Map<string, KeyringOptions>();
  private readonly _idSet = new Set<string>();

  constructor(entries: PatchAllEntry[]) {
    if (entries.length === 0) {
      throw new Error("Configurate.patchAll requires at least one entry.");
    }
    for (const entry of entries) {
      assertNonEmptyId(this._idSet, entry.id);
    }
    this._entries = entries;
  }

  lock(id: string, opts: KeyringOptions): this {
    if (!this._idSet.has(id)) {
      throw new Error(`Unknown id '${id}' passed to patchAll().lock().`);
    }
    this._lockById.set(id, opts);
    return this;
  }

  lockAll(opts: KeyringOptions): this {
    this._lockAll = opts;
    return this;
  }

  async run(): Promise<BatchRunResult> {
    const payloadEntries: Array<{
      id: string;
      payload: Record<string, unknown>;
    }> = [];
    const preflightResults: Record<string, BatchRunEntryResult> = {};

    for (const entry of this._entries) {
      const lockOpts = this._lockById.get(entry.id) ?? this._lockAll;
      try {
        payloadEntries.push({
          id: entry.id,
          payload: entry.config._buildPayload(
            "patch",
            entry.data as Partial<InferUnlocked<SchemaObject>>,
            lockOpts,
            false,
            false,
          ),
        });
      } catch (error) {
        preflightResults[entry.id] = {
          ok: false,
          error: toBatchError(error, "payload_build_failed"),
        };
      }
    }

    if (payloadEntries.length === 0) {
      return { results: preflightResults };
    }

    const payload = { entries: payloadEntries };
    const backendResult = await invoke<BatchRunResult>(
      "plugin:configurate|patch_all",
      { payload },
    );
    return {
      results: {
        ...backendResult.results,
        ...preflightResults,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Configurate class
// ---------------------------------------------------------------------------

/** Event payload received from `configurate://change` events. */
export interface ConfigChangeEvent {
  fileName: string;
  operation: string;
  targetId: string;
}

export class Configurate<S extends SchemaObject> {
  private readonly _schema: S;
  private readonly _opts: NormalizedConfigurateInit<S>;
  private readonly _changeTargetId: string;
  private readonly _keyringPaths: {
    id: string;
    dotpath: string;
    isOptional?: boolean;
  }[];
  private readonly _hasKeyringFields: boolean;
  private readonly _hasArrayKeyring: boolean;
  private readonly _sqliteColumns: SqliteColumn[];

  constructor(opts: ConfigurateInit<S>) {
    const normalized = normalizeConfigurateInit(opts);

    this._schema = normalized.schema;
    validateSchemaArrays(this._schema);
    this._opts = normalized;
    this._changeTargetId = buildChangeTargetId(
      normalized as NormalizedConfigurateInit<SchemaObject>,
    );
    this._keyringPaths = collectStaticKeyringPaths(this._schema);
    this._hasKeyringFields = hasAnyKeyring(this._schema);
    this._hasArrayKeyring = hasArrayKeyring(this._schema);
    this._sqliteColumns = collectSqliteColumns(this._schema);
  }

  /** Serializes the provider for IPC payloads. */
  private _serializeProvider(): Record<string, unknown> {
    const p = this._opts.provider;
    if (p.kind === "binary") {
      return { kind: "binary", encryptionKey: p.encryptionKey, kdf: p.kdf };
    }
    if (p.kind === "sqlite") {
      return { kind: "sqlite", dbName: p.dbName, tableName: p.tableName };
    }
    return { kind: p.kind };
  }

  /** Builds common base fields shared by all payloads. */
  private _buildBasePayload(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      fileName: this._opts.fileName,
      baseDir: this._opts.baseDir as number,
      provider: this._serializeProvider(),
    };
    if (this._opts.provider.kind === "sqlite") {
      base.schemaColumns = this._sqliteColumns;
    }
    if (this._opts.options !== undefined) {
      base.options = {
        dirName: this._opts.options.dirName,
        currentPath: this._opts.options.currentPath,
      };
    }
    return base;
  }

  static loadAll(entries: LoadAllEntry[]): LoadAllRunner {
    return new LoadAllBuilder(entries);
  }

  static saveAll(entries: SaveAllEntry[]): SaveAllRunner {
    return new SaveAllBuilder(entries);
  }

  static patchAll(entries: PatchAllEntry[]): PatchAllRunner {
    return new PatchAllBuilder(entries);
  }

  create(data: InferUnlocked<S>): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "create", data);
  }

  load(): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "load");
  }

  save(data: InferUnlocked<S>): LazyConfigEntry<S> {
    return new LazyConfigEntry(this, "save", data);
  }

  async exists(): Promise<boolean> {
    const payload = this._buildPayload("exists", undefined, null, false, false);
    return invoke<boolean>("plugin:configurate|exists", { payload });
  }

  /**
   * Lists config file names in the resolved root directory.
   *
   * For file-based providers, scans for files matching the provider extension.
   * For SQLite, returns all `config_key` values in the table.
   */
  async list(): Promise<string[]> {
    const payload = this._buildLocationPayload();
    return invoke<string[]>("plugin:configurate|list_configs", { payload });
  }

  /**
   * Resets the config by deleting existing data and re-creating it with
   * the provided default data.
   */
  reset(data: InferUnlocked<S>): LazyConfigEntry<S> {
    return new LazyResetEntry(this, data) as unknown as LazyConfigEntry<S>;
  }

  /**
   * Exports the config data as a string in the specified format.
   *
   * @param format - Target format: "json", "yml", or "toml"
   * @returns The serialized config string
   */
  async exportAs(
    format: "json" | "yml" | "toml",
    opts?: KeyringOptions | null,
  ): Promise<string> {
    const loaded = opts
      ? await this.load().unlock(opts)
      : await this.load().run();
    const payload = {
      source: {
        ...this._buildBasePayload(),
        data: loaded.data,
        withUnlock: false,
        returnData: false,
      },
      targetFormat: format,
    };
    return invoke<string>("plugin:configurate|export_config", { payload });
  }

  /**
   * Imports config data from a string in the specified format, replacing
   * the current stored config.
   *
   * @param content - The serialized config string
   * @param format  - Source format: "json", "yml", or "toml"
   */
  async importFrom(
    content: string,
    format: "json" | "yml" | "toml",
    opts?: KeyringOptions | null,
  ): Promise<void> {
    const parsed = await invoke<unknown>("plugin:configurate|import_config", {
      payload: {
        target: this._buildLocationPayload(),
        sourceFormat: format,
        content,
        parseOnly: true,
      },
    });
    const targetPayload = this._buildPayload(
      "save",
      parsed,
      opts ?? null,
      false,
      false,
    );
    await this._attachFullReplaceKeyringDeletes(targetPayload, opts ?? null);
    await invoke("plugin:configurate|import_config", {
      payload: {
        target: targetPayload,
      },
    });
  }

  /**
   * Validates data against the schema without writing to storage.
   *
   * @param data - Full config data to validate
   * @throws Error if validation fails
   */
  validate(data: InferUnlocked<S>): void {
    assertDataMatchesSchema(
      this._schema,
      data,
      this._opts.validation.allowUnknownKeys,
    );
  }

  /**
   * Validates partial data against the schema without writing to storage.
   *
   * @param data - Partial config data to validate
   * @throws Error if validation fails
   */
  validatePartial(data: Partial<InferUnlocked<S>>): void {
    assertPartialDataMatchesSchema(
      this._schema,
      data,
      this._opts.validation.allowUnknownKeys,
    );
  }

  /**
   * Partially update an existing config by deep-merging `partial` into the
   * stored data.  Only provided keys are updated; omitted keys are left
   * unchanged.
   *
   * **Null semantics (JSON Merge Patch — RFC 7396)**
   * Setting a key to `null` in `partial` overwrites the stored value with
   * `null`.  To leave a value unchanged, omit the key entirely.  This differs
   * from a full `save()`, which always replaces all keys.
   *
   * **Error behaviour**
   * By default, patching a config that does not yet exist throws an error.
   * Chain `.createIfMissing()` to create it instead:
   * ```ts
   * await config.patch({ theme: "dark" }).createIfMissing().run();
   * ```
   */
  patch(partial: Partial<InferUnlocked<S>>): LazyPatchEntry<S> {
    return new LazyPatchEntry(this, partial);
  }

  /**
   * Registers a callback that fires whenever this config file is changed
   * (create, save, patch, delete). Returns an unlisten function.
   */
  async onChange(
    callback: (event: ConfigChangeEvent) => void,
  ): Promise<() => void> {
    return tauriListen<ConfigChangeEvent>("configurate://change", (event) => {
      if (event.payload.targetId === this._changeTargetId) {
        callback(event.payload);
      }
    });
  }

  /**
   * Builds the minimal location-only payload used by file-watch commands.
   * These commands only need the file path (fileName + baseDir + options),
   * not any data or keyring fields.
   */
  private _buildLocationPayload(): Record<string, unknown> {
    return {
      ...this._buildBasePayload(),
      withUnlock: false,
      returnData: false,
    };
  }

  /**
   * Starts watching this config file for external changes (changes made by
   * other processes). Calls `watch_file` on the Rust side (file-based
   * providers only — throws for SQLite).
   *
   * Returns an async stop function that unregisters the listener and
   * calls `unwatch_file`.
   */
  async watchExternal(
    callback: (event: ConfigChangeEvent) => void,
  ): Promise<() => Promise<void>> {
    const payload = this._buildLocationPayload();
    // Register JS listener first to avoid losing events.
    const unlisten = await tauriListen<ConfigChangeEvent>(
      "configurate://change",
      (event) => {
        if (
          event.payload.targetId === this._changeTargetId &&
          event.payload.operation === "external_change"
        ) {
          callback(event.payload);
        }
      },
    );
    try {
      await invoke("plugin:configurate|watch_file", { payload });
    } catch (e) {
      unlisten();
      throw e;
    }
    return async () => {
      unlisten();
      await invoke("plugin:configurate|unwatch_file", { payload }).catch(
        () => {},
      );
    };
  }

  async delete(opts?: KeyringOptions | null): Promise<void> {
    const keyringOpts = opts ?? null;
    const payload = this._buildPayload("delete", undefined, null, false);

    if (keyringOpts !== null && this._hasKeyringFields) {
      let keyringEntries = this._keyringPaths.map(
        ({ id, dotpath, isOptional }) => ({
          id,
          dotpath,
          value: "",
          ...(isOptional ? { isOptional: true } : {}),
        }),
      );

      if (this._hasArrayKeyring) {
        try {
          const loadPayload = this._buildPayload(
            "load",
            undefined,
            null,
            false,
          );
          const plainData = await invoke<unknown>("plugin:configurate|load", {
            payload: loadPayload,
          });
          if (isPlainObject(plainData)) {
            keyringEntries = collectKeyringReadEntries(this._schema, plainData);
          }
        } catch {
          // Keep static non-array keyring entries as fallback.
        }
      }

      if (keyringEntries.length > 0) {
        payload.keyringEntries = keyringEntries;
        payload.keyringOptions = keyringOpts;
      }
    }

    await invoke("plugin:configurate|delete", { payload });
  }

  private async _loadExistingPlainData(): Promise<Record<string, unknown> | null> {
    try {
      const payload = this._buildPayload("load", undefined, null, false);
      const plainData = await invoke<unknown>("plugin:configurate|load", {
        payload,
      });
      return isPlainObject(plainData) ? plainData : null;
    } catch (e: unknown) {
      // Only swallow "not found" errors — rethrow everything else.
      if (
        typeof e === "object" &&
        e !== null &&
        "io_kind" in e &&
        (e as { io_kind: unknown }).io_kind === "not_found"
      ) {
        return null;
      }
      if (
        typeof e === "object" &&
        e !== null &&
        "kind" in e &&
        (e as { kind: unknown }).kind === "io" &&
        "message" in e &&
        typeof (e as { message: unknown }).message === "string" &&
        ((e as { message: string }).message.toLowerCase().includes("not found") ||
         (e as { message: string }).message.toLowerCase().includes("no such file"))
      ) {
        return null;
      }
      throw e;
    }
  }

  /** @internal */
  async _attachFullReplaceKeyringDeletes(
    payload: Record<string, unknown>,
    keyringOpts: KeyringOptions | null,
  ): Promise<void> {
    if (keyringOpts === null || !this._hasKeyringFields) {
      return;
    }

    const existingPlainData = await this._loadExistingPlainData();
    if (existingPlainData === null) {
      return;
    }

    const existingIds = new Set(
      collectKeyringReadEntries(this._schema, existingPlainData).map(
        (entry) => entry.id,
      ),
    );
    const nextIds = new Set(
      (
        (payload.keyringEntries as Array<{ id: string }> | undefined) ?? []
      ).map((entry) => entry.id),
    );
    const deleteIds = [...existingIds].filter((id) => !nextIds.has(id));

    if (deleteIds.length === 0) {
      return;
    }

    payload.keyringDeleteIds = deleteIds;
    payload.keyringOptions = keyringOpts;
  }

  /** @internal */
  async _postProcessLoadedData(data: unknown): Promise<unknown> {
    if (!isPlainObject(data)) {
      return data;
    }

    const { result, didMigrate } = this._applyPostLoad(data);
    if (didMigrate) {
      await this._savePlain(result).catch((e: unknown) => {
        console.warn(
          `[configurate] Failed to auto-save migrated config '${this._opts.fileName}':`,
          e,
        );
      });
    }

    return result;
  }

  /** @internal */
  _applyPostLoad(data: Record<string, unknown>): {
    result: Record<string, unknown>;
    didMigrate: boolean;
  } {
    let result = data;
    let didMigrate = false;
    if (this._opts.version !== undefined && this._opts.migrations) {
      const migrationResult = applyMigrations(
        result as InferUnlocked<S> & Record<string, unknown>,
        this._opts.version,
        this._opts.migrations,
      );
      result = migrationResult.result;
      didMigrate = migrationResult.didMigrate;
    }
    if (this._opts.defaults) {
      result = deepMergeDefaults(
        result,
        this._opts.defaults as Record<string, unknown>,
      );
    }
    return { result, didMigrate };
  }

  /**
   * Saves locked (plain) data without touching keyring.
   * Used for migration auto-save. Failures are logged as warnings but never
   * surface to the caller — a failed auto-save is non-fatal because the
   * migrated data is still available in memory for the current session.
   */
  private async _savePlain(lockedData: Record<string, unknown>): Promise<void> {
    const plainData = this._hasKeyringFields
      ? separateSecrets(this._schema, lockedData).plain
      : lockedData;
    const payload: Record<string, unknown> = {
      ...this._buildBasePayload(),
      withUnlock: false,
      returnData: false,
      data: plainData,
    };
    await invoke("plugin:configurate|save", { payload });
  }

  /** @internal */
  async _executeLocked(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions | null,
  ): Promise<LockedConfig<S>> {
    if (op === "load") {
      const payload = this._buildPayload(op, data, keyringOpts, false);
      const rawResult = await invoke<Record<string, unknown>>(
        `plugin:configurate|${op}`,
        {
          payload,
        },
      );
      const result = (await this._postProcessLoadedData(
        rawResult,
      )) as Record<string, unknown>;
      this._validateLoadedData(result);
      return new LockedConfig(result as InferLocked<S>, this);
    }

    const payload = this._buildPayload(op, data, keyringOpts, false, true);
    await this._attachFullReplaceKeyringDeletes(payload, keyringOpts);
    await invoke(`plugin:configurate|${op}`, {
      payload,
    });

    const plain = (payload.data ?? {}) as InferLocked<S>;
    return new LockedConfig(plain, this);
  }

  /** @internal */
  async _executeUnlock(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    if (op === "load") {
      const payload = this._buildPayload("load", data, null, false);
      const rawPlain = await invoke<Record<string, unknown>>(
        "plugin:configurate|load",
        {
          payload,
        },
      );
      const result = (await this._postProcessLoadedData(
        rawPlain,
      )) as Record<string, unknown>;
      return this._unlockFromData(result, keyringOpts);
    }

    const payload = this._buildPayload(op, data, keyringOpts, true);
    await this._attachFullReplaceKeyringDeletes(payload, keyringOpts);
    const result = await invoke<InferUnlocked<S>>(`plugin:configurate|${op}`, {
      payload,
    });
    return new UnlockedConfig(result);
  }

  /** @internal */
  async _executePatchLocked(
    data: Partial<InferUnlocked<S>>,
    keyringOpts: KeyringOptions | null,
    createIfMissing = false,
  ): Promise<PatchedConfig<S>> {
    const payload = this._buildPayload(
      "patch",
      data,
      keyringOpts,
      false,
      false,
    );
    if (createIfMissing) payload.createIfMissing = true;
    await invoke("plugin:configurate|patch", { payload });
    const plain = (payload.data ?? {}) as Partial<InferLocked<S>>;
    return new PatchedConfig(plain);
  }

  /** @internal */
  async _executePatchUnlock(
    data: Partial<InferUnlocked<S>>,
    keyringOpts: KeyringOptions,
    createIfMissing = false,
  ): Promise<UnlockedConfig<S>> {
    const payload = this._buildPayload("patch", data, keyringOpts, true);
    if (createIfMissing) payload.createIfMissing = true;
    const result = await invoke<InferUnlocked<S>>("plugin:configurate|patch", {
      payload,
    });
    return new UnlockedConfig(result);
  }

  /** @internal */
  async _unlockLoadedData(
    data: unknown,
    keyringOpts: KeyringOptions,
  ): Promise<unknown> {
    this._validateLoadedData(data);
    if (!isPlainObject(data)) {
      return data;
    }
    const unlocked = await this._unlockFromData(data, keyringOpts);
    return unlocked.data;
  }

  /** @internal */
  _validateLoadedData(data: unknown): void {
    if (!this._opts.validation.validateOnRead) {
      return;
    }
    assertDataMatchesSchema(
      this._schema,
      data,
      this._opts.validation.allowUnknownKeys,
    );
  }

  private _validateWriteData(data: unknown): void {
    if (!this._opts.validation.validateOnWrite) {
      return;
    }
    assertDataMatchesSchema(
      this._schema,
      data,
      this._opts.validation.allowUnknownKeys,
    );
  }

  private _validatePatchData(data: unknown): void {
    if (!this._opts.validation.validateOnWrite) {
      return;
    }
    assertPartialDataMatchesSchema(
      this._schema,
      data,
      this._opts.validation.allowUnknownKeys,
    );
  }

  /** @internal */
  async _unlockFromData(
    plainData: Record<string, unknown>,
    opts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    if (!this._hasKeyringFields) {
      this._validateLoadedData(plainData);
      return new UnlockedConfig(plainData as InferUnlocked<S>);
    }

    const keyringEntries = collectKeyringReadEntries(this._schema, plainData);

    if (keyringEntries.length === 0) {
      this._validateLoadedData(plainData);
      return new UnlockedConfig(plainData as InferUnlocked<S>);
    }

    const payload = {
      data: plainData,
      keyringEntries,
      keyringOptions: opts,
    };

    const result = await invoke<InferUnlocked<S>>("plugin:configurate|unlock", {
      payload,
    });
    this._validateLoadedData(result);
    return new UnlockedConfig(result);
  }

  /** @internal */
  async _executeReset(
    data: InferUnlocked<S>,
    keyringOpts: KeyringOptions | null,
  ): Promise<LockedConfig<S>> {
    const payload = this._buildPayload("create", data, keyringOpts, false, true);
    await this._attachFullReplaceKeyringDeletes(payload, keyringOpts);
    // Use reset command instead of create.
    await invoke("plugin:configurate|reset", { payload });
    const plain = (payload.data ?? {}) as InferLocked<S>;
    return new LockedConfig(plain, this);
  }

  /** @internal */
  async _executeResetUnlock(
    data: InferUnlocked<S>,
    keyringOpts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    const payload = this._buildPayload("create", data, keyringOpts, true);
    await this._attachFullReplaceKeyringDeletes(payload, keyringOpts);
    const result = await invoke<InferUnlocked<S>>("plugin:configurate|reset", {
      payload,
    });
    return new UnlockedConfig(result);
  }

  /** @internal */
  _buildPayload(
    op: "create" | "load" | "save" | "patch" | "delete" | "exists",
    data: unknown,
    keyringOpts: KeyringOptions | null,
    withUnlock: boolean,
    returnData = true,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ...this._buildBasePayload(),
      withUnlock,
      returnData,
    };

    if (
      op === "load" ||
      op === "delete" ||
      op === "exists" ||
      (op === "patch" && data === undefined)
    ) {
      if (keyringOpts && this._keyringPaths.length > 0) {
        base.keyringEntries = this._keyringPaths.map(
          ({ id, dotpath, isOptional }) => ({
            id,
            dotpath,
            value: "",
            ...(isOptional ? { isOptional: true } : {}),
          }),
        );
        base.keyringOptions = keyringOpts;
      }
      return base;
    }

    if (data !== undefined) {
      if (op === "patch") {
        this._validatePatchData(data);
      } else {
        this._validateWriteData(data);
      }
      // Work on a shallow copy to avoid mutating the caller's data object.
      let writeData = data;
      if (this._opts.version !== undefined && isPlainObject(data)) {
        writeData = { ...(data as Record<string, unknown>), [CONFIGURATE_VERSION_KEY]: this._opts.version };
      }
      if (!this._hasKeyringFields) {
        // No keyring fields — skip the deep clone in separateSecrets.
        base.data = writeData;
      } else {
        const { plain, keyringEntries } = separateSecrets(
          this._schema,
          writeData as Record<string, unknown>,
        );
        base.data = plain;
        if (keyringEntries.length > 0) {
          if (keyringOpts === null) {
            if (op === "patch") {
              throw new Error(
                "Configurate: patch payload contains keyring fields — use .lock(opts) before .run(), or .unlock(opts).",
              );
            }
            throw new Error(
              "Configurate: schema contains keyring fields — use .lock(opts) before .run(), or .unlock(opts), for create/save operations.",
            );
          }
          base.keyringEntries = keyringEntries;
          base.keyringOptions = keyringOpts;
        } else if (keyringOpts === null && op !== "patch") {
          throw new Error(
            "Configurate: schema contains keyring fields — use .lock(opts) before .run(), or .unlock(opts), for create/save operations.",
          );
        }
      }
    }

    return base;
  }
}

// ---------------------------------------------------------------------------
// Config Diff utility
// ---------------------------------------------------------------------------

export interface DiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Computes a shallow diff between two config objects.
 *
 * Returns an array of `DiffEntry` objects describing added, removed, and
 * changed keys.  Nested objects are compared recursively using dot-separated
 * paths.
 *
 * @example
 * ```ts
 * const changes = configDiff(
 *   { theme: "light", fontSize: 14 },
 *   { theme: "dark", fontSize: 14, lang: "en" },
 * );
 * // [
 * //   { path: "theme", type: "changed", oldValue: "light", newValue: "dark" },
 * //   { path: "lang", type: "added", newValue: "en" },
 * // ]
 * ```
 */
export function configDiff(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  prefix = "",
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  const allKeys = new Set([
    ...Object.keys(oldData),
    ...Object.keys(newData),
  ]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inOld = key in oldData;
    const inNew = key in newData;

    if (!inOld && inNew) {
      entries.push({ path, type: "added", newValue: newData[key] });
      continue;
    }
    if (inOld && !inNew) {
      entries.push({ path, type: "removed", oldValue: oldData[key] });
      continue;
    }

    const oldVal = oldData[key];
    const newVal = newData[key];

    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      entries.push(
        ...configDiff(
          oldVal as Record<string, unknown>,
          newVal as Record<string, unknown>,
          path,
        ),
      );
    } else if (!deepEqual(oldVal, newVal)) {
      entries.push({ path, type: "changed", oldValue: oldVal, newValue: newVal });
    }
  }

  return entries;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}
