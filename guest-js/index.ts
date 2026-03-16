import { invoke } from "@tauri-apps/api/core";
export { BaseDirectory } from "@tauri-apps/api/path";
import type { BaseDirectory } from "@tauri-apps/api/path";

// ---------------------------------------------------------------------------
// Storage format (legacy compatibility)
// ---------------------------------------------------------------------------

/** Legacy format options accepted by the compatibility layer. */
export type StorageFormat = "json" | "yaml" | "yml" | "binary";

// ---------------------------------------------------------------------------
// Keyring marker types
// ---------------------------------------------------------------------------

/**
 * Brand key used to tag keyring-protected fields at runtime.
 *
 * A plain string property is used instead of a `Symbol` because some bundlers
 * can hoist computed `Symbol` property keys out of scope.
 */
const KEYRING_BRAND_KEY = "__configurate_keyring__" as const;

/** Phantom symbol used only in the type system – never appears at runtime. */
declare const _keyringBrandTag: unique symbol;

/**
 * Marker type produced by `keyring()`.
 * `T`  – runtime value type.
 * `Id` – literal keyring id.
 */
export type KeyringField<T, Id extends string> = {
  readonly [_keyringBrandTag]?: true;
  readonly _type: T;
  readonly _id: Id;
};

/** Options required when creating a keyring-protected field definition. */
export interface KeyringFieldOptions<Id extends string> {
  id: Id;
}

/**
 * Marks a schema field as keyring-protected.
 *
 * The `id` must be a non-empty string that does not contain `/`.
 * It is used as part of the OS keyring user string (`{account}/{id}`),
 * so `/` would create an ambiguous path-like structure.
 */
export function keyring<T, Id extends string>(
  _type: abstract new (...args: never[]) => T | ((...args: never[]) => T),
  opts: KeyringFieldOptions<Id>,
): KeyringField<T, Id> {
  if (!opts.id) {
    throw new Error("keyring() id must not be empty.");
  }
  if (opts.id.includes("/")) {
    throw new Error(
      `keyring() id '${opts.id}' must not contain '/' (it is used as a separator in the keyring user string).`,
    );
  }
  const field = { _type: undefined as unknown as T, _id: opts.id } as Record<string, unknown>;
  field[KEYRING_BRAND_KEY] = true;
  return field as KeyringField<T, Id>;
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

type PrimitiveConstructor = StringConstructor | NumberConstructor | BooleanConstructor;

type InferPrimitive<C> = C extends StringConstructor
  ? string
  : C extends NumberConstructor
    ? number
    : C extends BooleanConstructor
      ? boolean
      : never;

type SchemaArrayElement = PrimitiveConstructor | KeyringField<unknown, string> | SchemaObject;

export type SchemaArray = readonly [SchemaArrayElement];

export type SchemaValue =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject
  | SchemaArray;

export type SchemaObject = { [key: string]: SchemaValue };

export type CollectKeyringIds<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<unknown, infer Id>
    ? Id
    : S[K] extends SchemaObject
      ? CollectKeyringIds<S[K]>
      : never;
}[keyof S];

type IsDuplicate<T extends string, All extends string> = T extends Exclude<All, T> ? true : false;

export type HasDuplicateKeyringIds<S extends SchemaObject> = true extends {
  [Id in CollectKeyringIds<S>]: IsDuplicate<Id, CollectKeyringIds<S>>;
}[CollectKeyringIds<S>]
  ? true
  : false;

export type InferLocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<unknown, string>
    ? null
    : S[K] extends SchemaArray
      ? S[K][0] extends KeyringField<unknown, string>
        ? null[]
        : S[K][0] extends PrimitiveConstructor
        ? InferPrimitive<S[K][0]>[]
        : S[K][0] extends SchemaObject
          ? InferLocked<S[K][0]>[]
          : never
    : S[K] extends SchemaObject
      ? InferLocked<S[K]>
      : S[K] extends PrimitiveConstructor
        ? InferPrimitive<S[K]>
        : never;
};

export type InferUnlocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<infer T, string>
    ? T
    : S[K] extends SchemaArray
      ? S[K][0] extends KeyringField<infer T, string>
        ? T[]
        : S[K][0] extends PrimitiveConstructor
        ? InferPrimitive<S[K][0]>[]
        : S[K][0] extends SchemaObject
          ? InferUnlocked<S[K][0]>[]
          : never
    : S[K] extends SchemaObject
      ? InferUnlocked<S[K]>
      : S[K] extends PrimitiveConstructor
        ? InferPrimitive<S[K]>
        : never;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderBrand = { readonly __configurateProviderBrand: true };

type ProviderPayload =
  | { kind: "json" }
  | { kind: "yml" }
  | { kind: "binary"; encryptionKey?: string }
  | { kind: "sqlite"; dbName?: string; tableName?: string };

export type ConfigurateProvider = ProviderBrand & Readonly<ProviderPayload>;

const PROVIDER_BRAND_KEY = "__configurateProviderBrand" as const;
const SQLITE_DEFAULT_DB = "configurate.db" as const;
const SQLITE_DEFAULT_TABLE = "configurate_configs" as const;

function createProvider(payload: ProviderPayload): ConfigurateProvider {
  const provider = {
    ...payload,
    [PROVIDER_BRAND_KEY]: true,
  } as const;
  return Object.freeze(provider) as ConfigurateProvider;
}

function isProvider(input: unknown): input is ConfigurateProvider {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const value = input as Record<string, unknown>;
  if (value[PROVIDER_BRAND_KEY] !== true) {
    return false;
  }
  const kind = value.kind;
  return kind === "json" || kind === "yml" || kind === "binary" || kind === "sqlite";
}

export function JsonProvider(): ConfigurateProvider {
  return createProvider({ kind: "json" });
}

export function YmlProvider(): ConfigurateProvider {
  return createProvider({ kind: "yml" });
}

export function BinaryProvider(opts?: { encryptionKey?: string }): ConfigurateProvider {
  return createProvider({ kind: "binary", encryptionKey: opts?.encryptionKey });
}

export function SqliteProvider(opts?: {
  dbName?: string;
  tableName?: string;
}): ConfigurateProvider {
  return createProvider({
    kind: "sqlite",
    dbName: opts?.dbName ?? SQLITE_DEFAULT_DB,
    tableName: opts?.tableName ?? SQLITE_DEFAULT_TABLE,
  });
}

/** @deprecated Use `YmlProvider()` instead. */
export function YamlProvider(): ConfigurateProvider {
  warnDeprecatedOnce(
    "provider-yaml-name",
    "YamlProvider() is deprecated. Use YmlProvider() instead.",
  );
  return YmlProvider();
}

// ---------------------------------------------------------------------------
// Keyring options
// ---------------------------------------------------------------------------

export interface KeyringOptions {
  service: string;
  account: string;
}

// ---------------------------------------------------------------------------
// Internal runtime helpers
// ---------------------------------------------------------------------------

function isKeyringField(val: SchemaValue): val is KeyringField<unknown, string> {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<string, unknown>)[KEYRING_BRAND_KEY] === true
  );
}

function isPrimitiveConstructor(val: unknown): val is PrimitiveConstructor {
  return val === String || val === Number || val === Boolean;
}

function isSchemaArrayElement(val: unknown): val is SchemaArrayElement {
  if (isPrimitiveConstructor(val)) {
    return true;
  }
  if (isKeyringField(val as SchemaValue)) {
    return true;
  }
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isSchemaArray(val: SchemaValue): val is SchemaArray {
  return Array.isArray(val) && val.length === 1 && isSchemaArrayElement(val[0]);
}

function isSchemaObject(val: SchemaValue): val is SchemaObject {
  return typeof val === "object" && val !== null && !Array.isArray(val) && !isKeyringField(val);
}

type KeyringPath = Array<string | number>;
type KeyringPayloadEntry = { id: string; dotpath: string; value: string };

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function validateSchemaArrays(schema: SchemaObject, prefix = ""): void {
  for (const [key, val] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(val) && !isSchemaArray(val as SchemaValue)) {
      throw new Error(
        `Invalid array schema at '${path}'. Arrays must contain exactly one element schema, e.g. [String] or [{ field: String }].`,
      );
    }
    if (isSchemaObject(val)) {
      validateSchemaArrays(val, path);
      continue;
    }
    if (isSchemaArray(val) && isSchemaObject(val[0])) {
      validateSchemaArrays(val[0], `${path}[]`);
    }
  }
}

function hasAnyKeyring(schema: SchemaObject): boolean {
  for (const val of Object.values(schema)) {
    if (isKeyringField(val)) {
      return true;
    }
    if (isSchemaObject(val) && hasAnyKeyring(val)) {
      return true;
    }
    if (isSchemaArray(val)) {
      const element = val[0];
      if (isKeyringField(element)) {
        return true;
      }
      if (isSchemaObject(element) && hasAnyKeyring(element)) {
        return true;
      }
    }
  }
  return false;
}

function hasArrayKeyring(schema: SchemaObject): boolean {
  for (const val of Object.values(schema)) {
    if (isSchemaObject(val) && hasArrayKeyring(val)) {
      return true;
    }
    if (!isSchemaArray(val)) {
      continue;
    }
    const element = val[0];
    if (isKeyringField(element)) {
      return true;
    }
    if (isSchemaObject(element) && hasAnyKeyring(element)) {
      return true;
    }
  }
  return false;
}

function dotpathFromPath(path: KeyringPath): string {
  return path.map((segment) => segment.toString()).join(".");
}

function keyringEntryId(baseId: string, path: KeyringPath): string {
  const dotpath = dotpathFromPath(path);
  if (!path.some((segment) => typeof segment === "number")) {
    return baseId;
  }
  return `${baseId}::${encodeURIComponent(dotpath)}`;
}

function serializeKeyringValue(secret: unknown): string {
  if (typeof secret === "string") {
    return secret;
  }
  return JSON.stringify(secret) ?? "null";
}

function collectReadEntriesInArray(
  elementSchema: SchemaArrayElement,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
): void {
  if (!Array.isArray(node)) {
    return;
  }

  for (let idx = 0; idx < node.length; idx++) {
    const elementPath = [...path, idx];
    const elementNode = node[idx];
    if (isKeyringField(elementSchema)) {
      entries.push({
        id: keyringEntryId(elementSchema._id, elementPath),
        dotpath: dotpathFromPath(elementPath),
        value: "",
      });
      continue;
    }
    if (isSchemaObject(elementSchema)) {
      collectReadEntriesInObject(elementSchema, elementNode, elementPath, entries, true);
    }
  }
}

function collectReadEntriesInObject(
  schema: SchemaObject,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
  requireObjectNode: boolean,
): void {
  const objectNode = isPlainObject(node) ? node : null;
  if (requireObjectNode && objectNode === null) {
    return;
  }

  for (const [key, valueSchema] of Object.entries(schema)) {
    const keyPath = [...path, key];
    if (isKeyringField(valueSchema)) {
      entries.push({
        id: keyringEntryId(valueSchema._id, keyPath),
        dotpath: dotpathFromPath(keyPath),
        value: "",
      });
      continue;
    }

    const childNode = objectNode?.[key];
    if (isSchemaObject(valueSchema)) {
      collectReadEntriesInObject(valueSchema, childNode, keyPath, entries, requireObjectNode);
      continue;
    }
    if (isSchemaArray(valueSchema)) {
      collectReadEntriesInArray(valueSchema[0], childNode, keyPath, entries);
    }
  }
}

function collectWriteEntriesInArray(
  elementSchema: SchemaArrayElement,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
): void {
  if (!Array.isArray(node)) {
    return;
  }

  for (let idx = 0; idx < node.length; idx++) {
    const elementPath = [...path, idx];
    if (isKeyringField(elementSchema)) {
      const secret = node[idx];
      entries.push({
        id: keyringEntryId(elementSchema._id, elementPath),
        dotpath: dotpathFromPath(elementPath),
        value: serializeKeyringValue(secret),
      });
      node[idx] = null;
      continue;
    }
    if (isSchemaObject(elementSchema)) {
      collectWriteEntriesInObject(elementSchema, node[idx], elementPath, entries);
    }
  }
}

function collectWriteEntriesInObject(
  schema: SchemaObject,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
): void {
  if (!isPlainObject(node)) {
    return;
  }

  for (const [key, valueSchema] of Object.entries(schema)) {
    const keyPath = [...path, key];
    if (isKeyringField(valueSchema)) {
      if (!(key in node)) {
        continue;
      }
      const secret = node[key];
      entries.push({
        id: keyringEntryId(valueSchema._id, keyPath),
        dotpath: dotpathFromPath(keyPath),
        value: serializeKeyringValue(secret),
      });
      node[key] = null;
      continue;
    }
    if (isSchemaObject(valueSchema)) {
      collectWriteEntriesInObject(valueSchema, node[key], keyPath, entries);
      continue;
    }
    if (isSchemaArray(valueSchema)) {
      collectWriteEntriesInArray(valueSchema[0], node[key], keyPath, entries);
    }
  }
}

function collectKeyringIds(schema: SchemaObject): string[] {
  const ids: string[] = [];
  for (const val of Object.values(schema)) {
    if (isKeyringField(val)) {
      ids.push(val._id);
      continue;
    }
    if (isSchemaObject(val)) {
      ids.push(...collectKeyringIds(val));
      continue;
    }
    if (isSchemaArray(val)) {
      const element = val[0];
      if (isKeyringField(element)) {
        ids.push(element._id);
      } else if (isSchemaObject(element)) {
        ids.push(...collectKeyringIds(element));
      }
    }
  }
  return ids;
}

function collectStaticKeyringPaths(
  schema: SchemaObject,
  prefix = "",
): Array<{ id: string; dotpath: string }> {
  const result: Array<{ id: string; dotpath: string }> = [];
  for (const [key, valueSchema] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isKeyringField(valueSchema)) {
      result.push({ id: valueSchema._id, dotpath: path });
      continue;
    }
    if (isSchemaObject(valueSchema)) {
      result.push(...collectStaticKeyringPaths(valueSchema, path));
    }
  }
  return result;
}

function collectKeyringReadEntries(
  schema: SchemaObject,
  data: Record<string, unknown>,
): KeyringPayloadEntry[] {
  const entries: KeyringPayloadEntry[] = [];
  collectReadEntriesInObject(schema, data, [], entries, false);
  return entries;
}

function separateSecrets(
  schema: SchemaObject,
  data: Record<string, unknown>,
): {
  plain: Record<string, unknown>;
  keyringEntries: KeyringPayloadEntry[];
} {
  const plain = structuredClone(data) as Record<string, unknown>;
  const keyringEntries: KeyringPayloadEntry[] = [];
  collectWriteEntriesInObject(schema, plain, [], keyringEntries);

  return { plain, keyringEntries };
}

type SqliteValueType = "string" | "number" | "boolean";

interface SqliteColumn {
  columnName: string;
  dotpath: string;
  valueType: SqliteValueType;
  isKeyring: boolean;
}

function dotpathToColumnName(dotpath: string): string {
  const normalized = dotpath.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  return normalized.toLowerCase();
}

function collectSqliteColumns(
  schema: SchemaObject,
  prefix = "",
  out: SqliteColumn[] = [],
): SqliteColumn[] {
  for (const [key, val] of Object.entries(schema)) {
    const dotpath = prefix ? `${prefix}.${key}` : key;

    if (isKeyringField(val)) {
      out.push({
        columnName: dotpathToColumnName(dotpath),
        dotpath,
        valueType: "string",
        isKeyring: true,
      });
      continue;
    }

    if (isSchemaObject(val)) {
      collectSqliteColumns(val, dotpath, out);
      continue;
    }

    if (isSchemaArray(val)) {
      out.push({
        columnName: dotpathToColumnName(dotpath),
        dotpath,
        valueType: "string",
        isKeyring: false,
      });
      continue;
    }

    if (val === String) {
      out.push({
        columnName: dotpathToColumnName(dotpath),
        dotpath,
        valueType: "string",
        isKeyring: false,
      });
      continue;
    }

    if (val === Number) {
      out.push({
        columnName: dotpathToColumnName(dotpath),
        dotpath,
        valueType: "number",
        isKeyring: false,
      });
      continue;
    }

    if (val === Boolean) {
      out.push({
        columnName: dotpathToColumnName(dotpath),
        dotpath,
        valueType: "boolean",
        isKeyring: false,
      });
      continue;
    }
  }

  // Run the column name collision check only at the top-level call, after all
  // nested schemas have been fully collected. Running it during recursive calls
  // would check partial sets and could give misleading results.
  if (prefix === "") {
    const seen = new Set<string>();
    for (const col of out) {
      if (seen.has(col.columnName)) {
        throw new Error(
          `SQLite schema column collision: '${col.columnName}'. Adjust schema field names to avoid collisions.`,
        );
      }
      seen.add(col.columnName);
    }
  }

  return out;
}

const deprecationWarnings = new Set<string>();

function warnDeprecatedOnce(key: string, message: string): void {
  if (deprecationWarnings.has(key)) {
    return;
  }
  deprecationWarnings.add(key);
  console.warn(`[tauri-plugin-configurate] ${message}`);
}

function normalizeLegacyFormatToProvider(
  format: StorageFormat,
  encryptionKey: string | undefined,
): ConfigurateProvider {
  if (format === "json") {
    return JsonProvider();
  }
  if (format === "yaml" || format === "yml") {
    return YmlProvider();
  }
  return BinaryProvider({ encryptionKey });
}

function assertNonEmptyId(ids: Set<string>, id: string): void {
  if (!id) {
    throw new Error("Batch entry id must not be empty.");
  }
  if (ids.has(id)) {
    throw new Error(`Batch entry id '${id}' is duplicated.`);
  }
  ids.add(id);
}

// ---------------------------------------------------------------------------
// Config objects
// ---------------------------------------------------------------------------

export interface ConfiguratePathOptions {
  dirName?: string;
  currentPath?: string;
}

export interface ConfigurateInit<S extends SchemaObject> {
  schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown);
  fileName: string;
  baseDir: BaseDirectory;
  provider: ConfigurateProvider;
  options?: ConfiguratePathOptions;
}

export interface LegacyConfigurateOptions {
  name: string;
  dir: BaseDirectory;
  format: StorageFormat;
  dirName?: string;
  path?: string;
  encryptionKey?: string;
}

interface ConfigurateCompatInit<S extends SchemaObject> {
  schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown);
  fileName?: string;
  name?: string;
  baseDir?: BaseDirectory;
  dir?: BaseDirectory;
  provider?: ConfigurateProvider;
  format?: StorageFormat;
  encryptionKey?: string;
  options?: ConfiguratePathOptions;
  dirName?: string;
  path?: string;
}

interface NormalizedConfigurateInit<S extends SchemaObject> {
  schema: S;
  fileName: string;
  baseDir: BaseDirectory;
  provider: ConfigurateProvider;
  options?: ConfiguratePathOptions;
}

function normalizeConfigurateInit<S extends SchemaObject>(
  input: ConfigurateCompatInit<S>,
): NormalizedConfigurateInit<S> {
  const schema = input.schema;

  const fileName = input.fileName ?? input.name;
  if (!fileName) {
    throw new Error('Configurate: "fileName" (or legacy "name") must be provided.');
  }
  if (input.fileName === undefined && input.name !== undefined) {
    warnDeprecatedOnce("legacy-name", '"name" is deprecated. Use "fileName" instead.');
  }

  const baseDir = input.baseDir ?? input.dir;
  if (baseDir === undefined) {
    throw new Error('Configurate: "baseDir" (or legacy "dir") must be provided.');
  }
  if (input.baseDir === undefined && input.dir !== undefined) {
    warnDeprecatedOnce("legacy-dir", '"dir" is deprecated. Use "baseDir" instead.');
  }

  let provider = input.provider;
  if (!provider) {
    if (!input.format) {
      throw new Error(
        'Configurate: "provider" is required (or legacy "format" for compatibility).',
      );
    }
    warnDeprecatedOnce(
      "legacy-format",
      '"format"/"encryptionKey" is deprecated. Use provider functions instead.',
    );
    provider = normalizeLegacyFormatToProvider(input.format, input.encryptionKey);
  } else if (!isProvider(provider)) {
    throw new Error(
      "Configurate: provider must be created by JsonProvider/YmlProvider/BinaryProvider/SqliteProvider.",
    );
  }

  const options = input.options
    ? {
        dirName: input.options.dirName,
        currentPath: input.options.currentPath,
      }
    : {
        dirName: input.dirName,
        currentPath: input.path,
      };

  if (!input.options && (input.dirName !== undefined || input.path !== undefined)) {
    warnDeprecatedOnce(
      "legacy-path-fields",
      '"dirName"/"path" at top-level is deprecated. Use options.{dirName,currentPath}.',
    );
  }

  if (
    provider.kind === "binary" &&
    provider.encryptionKey === undefined &&
    input.encryptionKey !== undefined
  ) {
    provider = BinaryProvider({ encryptionKey: input.encryptionKey });
  }

  if (
    provider.kind !== "binary" &&
    "encryptionKey" in provider &&
    provider.encryptionKey !== undefined
  ) {
    throw new Error(
      `encryptionKey is only supported with provider.kind="binary", got "${provider.kind}".`,
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

  if (options.dirName !== undefined) {
    const segments = options.dirName.split(/[\\/]/);
    if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new Error('Configurate: "options.dirName" must not contain empty or special segments.');
    }
  }
  if (options.currentPath !== undefined) {
    const segments = options.currentPath.split(/[\\/]/);
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
    options: options.dirName || options.currentPath ? options : undefined,
  };
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
    op: "create" | "load" | "save" | "delete",
    data: unknown,
    keyringOpts: KeyringOptions | null,
    withUnlock: boolean,
    returnData?: boolean,
  ): Record<string, unknown>;
  _unlockLoadedData(data: unknown, keyringOpts: KeyringOptions): Promise<unknown>;
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
    return this._configurate._unlockFromData(this.data as Record<string, unknown>, opts);
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
      throw new Error("Cannot access data after lock() has been called. Load or unlock again.");
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
    return this._configurate._executeLocked(this._op, this._data, this._keyringOpts);
  }

  unlock(opts: KeyringOptions): Promise<UnlockedConfig<S>> {
    return this._configurate._executeUnlock(this._op, this._data, opts);
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

    const batchResult = await invoke<BatchRunResult>("plugin:configurate|load_all", { payload });

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

        const unlockedData = await entry.config._unlockLoadedData(result.data, unlockOpts);
        batchResult.results[entry.id] = { ok: true, data: unlockedData };
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
    const payload = {
      entries: this._entries.map((entry) => {
        const lockOpts = this._lockById.get(entry.id) ?? this._lockAll;
        return {
          id: entry.id,
          payload: entry.config._buildPayload(
            "save",
            entry.data as InferUnlocked<SchemaObject>,
            lockOpts,
            false,
            false,
          ),
        };
      }),
    };

    return invoke<BatchRunResult>("plugin:configurate|save_all", { payload });
  }
}

// ---------------------------------------------------------------------------
// Configurate class
// ---------------------------------------------------------------------------

export class Configurate<S extends SchemaObject> {
  private readonly _schema: S;
  private readonly _opts: NormalizedConfigurateInit<S>;
  private readonly _keyringPaths: { id: string; dotpath: string }[];
  private readonly _hasKeyringFields: boolean;
  private readonly _hasArrayKeyring: boolean;
  private readonly _sqliteColumns: SqliteColumn[];

  constructor(opts: ConfigurateInit<S>);
  constructor(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    opts: LegacyConfigurateOptions,
  );
  constructor(
    schemaOrOpts:
      | ConfigurateInit<S>
      | (S & (true extends HasDuplicateKeyringIds<S> ? never : unknown)),
    legacyOpts?: LegacyConfigurateOptions,
  ) {
    const normalized =
      legacyOpts === undefined
        ? normalizeConfigurateInit(schemaOrOpts as ConfigurateCompatInit<S>)
        : normalizeConfigurateInit({
            schema: schemaOrOpts as S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
            ...legacyOpts,
          } as ConfigurateCompatInit<S>);

    if (legacyOpts !== undefined) {
      warnDeprecatedOnce(
        "legacy-constructor-signature",
        "Configurate(schema, opts) is deprecated. Use new Configurate({ schema, ... }) instead.",
      );
    }

    this._schema = normalized.schema;
    validateSchemaArrays(this._schema);
    this._opts = normalized;
    this._keyringPaths = collectStaticKeyringPaths(this._schema);
    this._hasKeyringFields = hasAnyKeyring(this._schema);
    this._hasArrayKeyring = hasArrayKeyring(this._schema);
    this._sqliteColumns = collectSqliteColumns(this._schema);
  }

  static loadAll(entries: LoadAllEntry[]): LoadAllRunner {
    return new LoadAllBuilder(entries);
  }

  static saveAll(entries: SaveAllEntry[]): SaveAllRunner {
    return new SaveAllBuilder(entries);
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

  async delete(opts?: KeyringOptions | null): Promise<void> {
    const keyringOpts = opts ?? null;
    const payload = this._buildPayload("delete", undefined, null, false);

    if (keyringOpts !== null && this._hasKeyringFields) {
      let keyringEntries = this._keyringPaths.map(({ id, dotpath }) => ({
        id,
        dotpath,
        value: "",
      }));

      if (this._hasArrayKeyring) {
        try {
          const loadPayload = this._buildPayload("load", undefined, null, false);
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

  /** @internal */
  async _executeLocked(
    op: "create" | "load" | "save",
    data: InferUnlocked<S> | undefined,
    keyringOpts: KeyringOptions | null,
  ): Promise<LockedConfig<S>> {
    if (op === "load") {
      const payload = this._buildPayload(op, data, keyringOpts, false);
      const result = await invoke<InferLocked<S>>(`plugin:configurate|${op}`, {
        payload,
      });
      return new LockedConfig(result, this);
    }

    const payload = this._buildPayload(op, data, keyringOpts, false, false);
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
      const plain = await invoke<Record<string, unknown>>("plugin:configurate|load", {
        payload,
      });
      return this._unlockFromData(plain, keyringOpts);
    }

    const payload = this._buildPayload(op, data, keyringOpts, true);
    const result = await invoke<InferUnlocked<S>>(`plugin:configurate|${op}`, {
      payload,
    });
    return new UnlockedConfig(result);
  }

  /** @internal */
  async _unlockLoadedData(data: unknown, keyringOpts: KeyringOptions): Promise<unknown> {
    if (!isPlainObject(data)) {
      return data;
    }
    const unlocked = await this._unlockFromData(data, keyringOpts);
    return unlocked.data;
  }

  /** @internal */
  async _unlockFromData(
    plainData: Record<string, unknown>,
    opts: KeyringOptions,
  ): Promise<UnlockedConfig<S>> {
    if (!this._hasKeyringFields) {
      return new UnlockedConfig(plainData as InferUnlocked<S>);
    }

    const keyringEntries = this._hasArrayKeyring
      ? collectKeyringReadEntries(this._schema, plainData)
      : this._keyringPaths.map(({ id, dotpath }) => ({
          id,
          dotpath,
          value: "",
        }));

    if (keyringEntries.length === 0) {
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
    return new UnlockedConfig(result);
  }

  /** @internal */
  _buildPayload(
    op: "create" | "load" | "save" | "delete",
    data: unknown,
    keyringOpts: KeyringOptions | null,
    withUnlock: boolean,
    returnData = true,
  ): Record<string, unknown> {
    const provider: ProviderPayload =
      this._opts.provider.kind === "binary"
        ? {
            kind: "binary",
            encryptionKey: this._opts.provider.encryptionKey,
          }
        : this._opts.provider.kind === "sqlite"
          ? {
              kind: "sqlite",
              dbName: this._opts.provider.dbName,
              tableName: this._opts.provider.tableName,
            }
          : { kind: this._opts.provider.kind };

    const base: Record<string, unknown> = {
      fileName: this._opts.fileName,
      baseDir: this._opts.baseDir as number,
      provider,
      withUnlock,
      returnData,
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

    if (op === "load" || op === "delete") {
      if (keyringOpts && this._keyringPaths.length > 0) {
        base.keyringEntries = this._keyringPaths.map(({ id, dotpath }) => ({
          id,
          dotpath,
          value: "",
        }));
        base.keyringOptions = keyringOpts;
      }
      return base;
    }

    if (data !== undefined) {
      if (!this._hasKeyringFields) {
        // No keyring fields — skip the deep clone in separateSecrets.
        base.data = data;
      } else {
        if (keyringOpts === null) {
          throw new Error(
            "Configurate: schema contains keyring fields — use .lock(opts) before .run(), or .unlock(opts), for create/save operations.",
          );
        }
        const { plain, keyringEntries } = separateSecrets(
          this._schema,
          data as Record<string, unknown>,
        );
        base.data = plain;
        if (keyringEntries.length > 0) {
          base.keyringEntries = keyringEntries;
          base.keyringOptions = keyringOpts;
        }
      }
    }

    return base;
  }
}

// ---------------------------------------------------------------------------
// ConfigurateFactory (compatibility wrapper)
// ---------------------------------------------------------------------------

export interface BuildConfig {
  name: string;
  path?: string | null;
  dirName?: string | null;
}

export interface ConfigurateFactoryBaseOptions {
  baseDir?: BaseDirectory;
  dir?: BaseDirectory;
  provider?: ConfigurateProvider;
  format?: StorageFormat;
  encryptionKey?: string;
  options?: ConfiguratePathOptions;
  dirName?: string;
  path?: string;
}

interface NormalizedFactoryBase {
  baseDir: BaseDirectory;
  provider: ConfigurateProvider;
  options?: ConfiguratePathOptions;
}

function normalizeFactoryBase(base: ConfigurateFactoryBaseOptions): NormalizedFactoryBase {
  const baseDir = base.baseDir ?? base.dir;
  if (baseDir === undefined) {
    throw new Error('ConfigurateFactory: "baseDir" (or legacy "dir") must be provided.');
  }

  if (base.baseDir === undefined && base.dir !== undefined) {
    warnDeprecatedOnce(
      "legacy-factory-dir",
      'ConfigurateFactory: "dir" is deprecated. Use "baseDir".',
    );
  }

  let provider = base.provider;
  if (provider && !isProvider(provider)) {
    throw new Error(
      "ConfigurateFactory: provider must be created by JsonProvider/YmlProvider/BinaryProvider/SqliteProvider.",
    );
  }
  if (!provider) {
    if (!base.format) {
      throw new Error('ConfigurateFactory: "provider" is required (or legacy "format").');
    }
    warnDeprecatedOnce(
      "legacy-factory-format",
      'ConfigurateFactory: "format"/"encryptionKey" is deprecated. Use provider functions.',
    );
    provider = normalizeLegacyFormatToProvider(base.format, base.encryptionKey);
  }

  const options = base.options
    ? {
        dirName: base.options.dirName,
        currentPath: base.options.currentPath,
      }
    : {
        dirName: base.dirName,
        currentPath: base.path,
      };

  if (!base.options && (base.dirName !== undefined || base.path !== undefined)) {
    warnDeprecatedOnce(
      "legacy-factory-options",
      'ConfigurateFactory: top-level "dirName"/"path" is deprecated. Use options.{dirName,currentPath}.',
    );
  }

  return {
    baseDir,
    provider,
    options: options.dirName || options.currentPath ? options : undefined,
  };
}

/**
 * @deprecated Use `new Configurate({ ... })` instead.
 */
export class ConfigurateFactory {
  private readonly _base: NormalizedFactoryBase;

  constructor(baseOpts: ConfigurateFactoryBaseOptions) {
    warnDeprecatedOnce(
      "legacy-configurate-factory",
      "ConfigurateFactory is deprecated and will be removed in the next minor version.",
    );
    this._base = normalizeFactoryBase(baseOpts);
  }

  build<S extends SchemaObject>(
    schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
    nameOrConfig: string | BuildConfig,
    dirName?: string,
  ): Configurate<S> {
    let fileName: string;
    let resolvedDirName = this._base.options?.dirName;
    let resolvedCurrentPath = this._base.options?.currentPath;

    if (typeof nameOrConfig === "string") {
      fileName = nameOrConfig;
      if (dirName !== undefined) {
        resolvedDirName = dirName;
      }
    } else {
      fileName = nameOrConfig.name;
      if (nameOrConfig.dirName !== undefined) {
        resolvedDirName = nameOrConfig.dirName ?? undefined;
      }
      if (nameOrConfig.path !== undefined) {
        resolvedCurrentPath = nameOrConfig.path ?? undefined;
      }
    }

    return new Configurate<S>({
      schema,
      fileName,
      baseDir: this._base.baseDir,
      provider: this._base.provider,
      options:
        resolvedDirName || resolvedCurrentPath
          ? {
              dirName: resolvedDirName,
              currentPath: resolvedCurrentPath,
            }
          : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// defineConfig helper
// ---------------------------------------------------------------------------

export function defineConfig<S extends SchemaObject>(
  schema: S & (true extends HasDuplicateKeyringIds<S> ? never : unknown),
): S {
  validateSchemaArrays(schema as SchemaObject);
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
