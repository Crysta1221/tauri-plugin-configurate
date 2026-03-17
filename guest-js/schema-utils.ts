/**
 * Internal schema utilities for tauri-plugin-configurate.
 *
 * This module contains all schema introspection, keyring collection,
 * SQLite column derivation, and data validation logic.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEYRING_BRAND_KEY = "__configurate_keyring__" as const;
export const KEYRING_RUNTIME_TYPE_KEY = "__configurate_keyring_type__" as const;
export const CONFIGURATE_VERSION_KEY = "__configurate_version__" as const;
export const OPTIONAL_BRAND_KEY = "__configurate_optional__" as const;

// ---------------------------------------------------------------------------
// Shared type imports from schema.ts
// (type-only — erased at build time, no circular runtime dependency)
// ---------------------------------------------------------------------------

import type {
  KeyringField,
  SchemaObject,
  SchemaValue,
  SchemaArray,
  MigrationStep,
} from "./schema";

type PrimitiveConstructor =
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor;
type SchemaArrayElement =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject;
type KeyringPath = Array<string | number>;

// OptionalField (structural duck-type — enough for runtime checks)
type OptionalFieldRuntime = {
  [OPTIONAL_BRAND_KEY]: true;
  _schema: SchemaValue;
};

export type KeyringPayloadEntry = {
  id: string;
  dotpath: string;
  value: string;
  /** When true a "not found" keyring error is treated as absent, not an error. */
  isOptional?: boolean;
};

export type SqliteValueType = "string" | "number" | "boolean";

export interface SqliteColumn {
  columnName: string;
  dotpath: string;
  valueType: SqliteValueType;
  isKeyring: boolean;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function isKeyringField(
  val: SchemaValue,
): val is KeyringField<unknown, string> {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<string, unknown>)[KEYRING_BRAND_KEY] === true
  );
}

export function isPrimitiveConstructor(
  val: unknown,
): val is PrimitiveConstructor {
  return val === String || val === Number || val === Boolean;
}

/** Returns true when `val` is an `OptionalField` marker produced by `optional()`. */
export function isOptionalField(
  val: SchemaValue,
): val is SchemaValue & OptionalFieldRuntime {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    (val as Record<string, unknown>)[OPTIONAL_BRAND_KEY] === true
  );
}

/** Unwraps an optional field and returns the inner schema and a flag. */
function unwrapOptional(val: SchemaValue): {
  schema: SchemaValue;
  isOptional: boolean;
} {
  if (isOptionalField(val)) {
    return { schema: (val as OptionalFieldRuntime)._schema, isOptional: true };
  }
  return { schema: val, isOptional: false };
}

function isSchemaArrayElement(val: unknown): val is SchemaArrayElement {
  if (isPrimitiveConstructor(val)) return true;
  if (isKeyringField(val as SchemaValue)) return true;
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function isSchemaArray(val: SchemaValue): val is SchemaArray {
  return Array.isArray(val) && val.length === 1 && isSchemaArrayElement(val[0]);
}

export function isSchemaObject(val: SchemaValue): val is SchemaObject {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    !isKeyringField(val) &&
    !isOptionalField(val)
  );
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

export function validateSchemaArrays(schema: SchemaObject, prefix = ""): void {
  for (const [key, rawVal] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const val = isOptionalField(rawVal)
      ? (rawVal as OptionalFieldRuntime)._schema
      : rawVal;
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

export function hasAnyKeyring(schema: SchemaObject): boolean {
  for (const rawVal of Object.values(schema)) {
    const val = isOptionalField(rawVal)
      ? (rawVal as OptionalFieldRuntime)._schema
      : rawVal;
    if (isKeyringField(val)) return true;
    if (isSchemaObject(val) && hasAnyKeyring(val)) return true;
    if (isSchemaArray(val)) {
      const element = val[0];
      if (isKeyringField(element)) return true;
      if (isSchemaObject(element) && hasAnyKeyring(element)) return true;
    }
  }
  return false;
}

export function hasArrayKeyring(schema: SchemaObject): boolean {
  for (const rawVal of Object.values(schema)) {
    const val = isOptionalField(rawVal)
      ? (rawVal as OptionalFieldRuntime)._schema
      : rawVal;
    if (isSchemaObject(val) && hasArrayKeyring(val)) return true;
    if (!isSchemaArray(val)) continue;
    const element = val[0];
    if (isKeyringField(element)) return true;
    if (isSchemaObject(element) && hasAnyKeyring(element)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Keyring entry collection
// ---------------------------------------------------------------------------

function dotpathFromPath(path: KeyringPath): string {
  return path.map((segment) => segment.toString()).join(".");
}

function keyringEntryId(baseId: string, path: KeyringPath): string {
  const dotpath = dotpathFromPath(path);
  if (!path.some((segment) => typeof segment === "number")) return baseId;
  return `${baseId}::${encodeURIComponent(dotpath)}`;
}

function serializeKeyringValue(secret: unknown): string {
  if (typeof secret === "string") return secret;
  return JSON.stringify(secret) ?? "null";
}

function collectReadEntriesInArray(
  elementSchema: SchemaArrayElement,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
  missingOptionalAncestor: boolean,
): void {
  if (!Array.isArray(node)) return;
  for (let idx = 0; idx < node.length; idx++) {
    const elementPath = [...path, idx];
    const elementNode = node[idx];
    if (isKeyringField(elementSchema)) {
      entries.push({
        id: keyringEntryId(elementSchema._id, elementPath),
        dotpath: dotpathFromPath(elementPath),
        value: "",
        isOptional: missingOptionalAncestor || undefined,
      });
      continue;
    }
    if (isSchemaObject(elementSchema)) {
      collectReadEntriesInObject(
        elementSchema,
        elementNode,
        elementPath,
        entries,
        true,
        missingOptionalAncestor,
      );
    }
  }
}

function collectReadEntriesInObject(
  schema: SchemaObject,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
  requireObjectNode: boolean,
  missingOptionalAncestor = false,
): void {
  const objectNode = isPlainObject(node) ? node : null;
  if (requireObjectNode && objectNode === null) return;

  for (const [key, rawValueSchema] of Object.entries(schema)) {
    const keyPath = [...path, key];
    const { schema: valueSchema, isOptional } = unwrapOptional(rawValueSchema);
    const childNode = objectNode?.[key];
    const keyringIsOptional =
      missingOptionalAncestor ||
      (isOptional && (childNode === undefined || childNode === null));

    if (isKeyringField(valueSchema)) {
      entries.push({
        id: keyringEntryId(valueSchema._id, keyPath),
        dotpath: dotpathFromPath(keyPath),
        value: "",
        isOptional: keyringIsOptional || undefined,
      });
      continue;
    }
    if (isSchemaObject(valueSchema)) {
      collectReadEntriesInObject(
        valueSchema,
        childNode,
        keyPath,
        entries,
        requireObjectNode,
        missingOptionalAncestor || (isOptional && !isPlainObject(childNode)),
      );
      continue;
    }
    if (isSchemaArray(valueSchema)) {
      collectReadEntriesInArray(
        valueSchema[0],
        childNode,
        keyPath,
        entries,
        missingOptionalAncestor,
      );
    }
  }
}

function collectWriteEntriesInArray(
  elementSchema: SchemaArrayElement,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
): void {
  if (!Array.isArray(node)) return;
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
      collectWriteEntriesInObject(
        elementSchema,
        node[idx],
        elementPath,
        entries,
      );
    }
  }
}

function collectWriteEntriesInObject(
  schema: SchemaObject,
  node: unknown,
  path: KeyringPath,
  entries: KeyringPayloadEntry[],
): void {
  if (!isPlainObject(node)) return;
  for (const [key, rawValueSchema] of Object.entries(schema)) {
    const keyPath = [...path, key];
    const { schema: valueSchema } = unwrapOptional(rawValueSchema);

    if (isKeyringField(valueSchema)) {
      if (!(key in node)) continue;
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

export function collectKeyringIds(schema: SchemaObject): string[] {
  const ids: string[] = [];
  for (const rawVal of Object.values(schema)) {
    const val = isOptionalField(rawVal)
      ? (rawVal as OptionalFieldRuntime)._schema
      : rawVal;
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
      if (isKeyringField(element)) ids.push(element._id);
      else if (isSchemaObject(element)) ids.push(...collectKeyringIds(element));
    }
  }
  return ids;
}

export function collectStaticKeyringPaths(
  schema: SchemaObject,
  prefix = "",
  inheritedOptional = false,
): Array<{ id: string; dotpath: string; isOptional?: boolean }> {
  const result: Array<{ id: string; dotpath: string; isOptional?: boolean }> =
    [];
  for (const [key, rawValueSchema] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const { schema: valueSchema, isOptional } = unwrapOptional(rawValueSchema);
    const optionalForPath = inheritedOptional || isOptional;
    if (isKeyringField(valueSchema)) {
      result.push({
        id: valueSchema._id,
        dotpath: path,
        isOptional: optionalForPath || undefined,
      });
      continue;
    }
    if (isSchemaObject(valueSchema)) {
      result.push(
        ...collectStaticKeyringPaths(valueSchema, path, optionalForPath),
      );
    }
  }
  return result;
}

export function collectKeyringReadEntries(
  schema: SchemaObject,
  data: Record<string, unknown>,
): KeyringPayloadEntry[] {
  const entries: KeyringPayloadEntry[] = [];
  collectReadEntriesInObject(schema, data, [], entries, false);
  return entries;
}

export function separateSecrets(
  schema: SchemaObject,
  data: Record<string, unknown>,
): { plain: Record<string, unknown>; keyringEntries: KeyringPayloadEntry[] } {
  // Clone first, then extract. If no keyring values were found in the data
  // (all fields absent or null), discard the clone and return the original
  // object — avoiding holding two copies of the data in memory simultaneously.
  const plain = structuredClone(data) as Record<string, unknown>;
  const keyringEntries: KeyringPayloadEntry[] = [];
  collectWriteEntriesInObject(schema, plain, [], keyringEntries);
  if (keyringEntries.length === 0) {
    // No real secrets present — return original, let clone be GC'd.
    return { plain: data, keyringEntries: [] };
  }
  return { plain, keyringEntries };
}

// ---------------------------------------------------------------------------
// SQLite column derivation
// ---------------------------------------------------------------------------

function dotpathToColumnName(dotpath: string): string {
  const normalized = dotpath.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  return normalized.toLowerCase();
}

export function collectSqliteColumns(
  schema: SchemaObject,
  prefix = "",
  out: SqliteColumn[] = [],
): SqliteColumn[] {
  for (const [key, rawVal] of Object.entries(schema)) {
    const dotpath = prefix ? `${prefix}.${key}` : key;
    const val = isOptionalField(rawVal)
      ? (rawVal as OptionalFieldRuntime)._schema
      : rawVal;

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function valueTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function primitiveSchemaLabel(schema: PrimitiveConstructor): string {
  if (schema === String) return "string";
  if (schema === Number) return "number";
  return "boolean";
}

function assertPrimitiveValue(
  schema: PrimitiveConstructor,
  value: unknown,
  path: string,
): void {
  const expected = primitiveSchemaLabel(schema);
  const isValid =
    (schema === String && typeof value === "string") ||
    (schema === Number &&
      typeof value === "number" &&
      Number.isFinite(value)) ||
    (schema === Boolean && typeof value === "boolean");
  if (!isValid) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Expected ${expected}, got ${valueTypeLabel(value)}.`,
    );
  }
}

function keyringPrimitiveSchema(
  schema: KeyringField<unknown, string>,
): PrimitiveConstructor | undefined {
  const ctor = (schema as Record<string, unknown>)[KEYRING_RUNTIME_TYPE_KEY];
  if (isPrimitiveConstructor(ctor)) return ctor;
  return undefined;
}

function assertSchemaValue(
  schemaValue: SchemaValue,
  value: unknown,
  path: string,
  allowUnknownKeys: boolean,
): void {
  const { schema: inner, isOptional } = unwrapOptional(schemaValue);
  // Optional field with missing/null/undefined value: always valid
  if (isOptional && (value === undefined || value === null)) return;
  schemaValue = inner;

  if (isKeyringField(schemaValue)) {
    if (value === null) return;
    const primitiveSchema = keyringPrimitiveSchema(schemaValue);
    if (primitiveSchema !== undefined)
      assertPrimitiveValue(primitiveSchema, value, path);
    return;
  }
  if (
    schemaValue === String ||
    schemaValue === Number ||
    schemaValue === Boolean
  ) {
    assertPrimitiveValue(schemaValue, value, path);
    return;
  }
  if (isSchemaObject(schemaValue)) {
    assertSchemaObject(schemaValue, value, path, allowUnknownKeys);
    return;
  }
  if (!isSchemaArray(schemaValue)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Unsupported schema node.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Expected array, got ${valueTypeLabel(value)}.`,
    );
  }
  const elementSchema = schemaValue[0];
  for (let idx = 0; idx < value.length; idx++) {
    assertSchemaValue(
      elementSchema,
      value[idx],
      `${path}[${idx}]`,
      allowUnknownKeys,
    );
  }
}

function assertSchemaObject(
  schema: SchemaObject,
  value: unknown,
  path: string,
  allowUnknownKeys: boolean,
): void {
  if (!isPlainObject(value)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Expected object, got ${valueTypeLabel(value)}.`,
    );
  }
  const objectValue = value as Record<string, unknown>;
  for (const [key, nestedSchema] of Object.entries(schema)) {
    if (!(key in objectValue)) {
      // Missing key: ok for optional fields, error for required fields
      if (isOptionalField(nestedSchema)) continue;
      throw new Error(
        `Configurate: schema validation failed at '${path}.${key}'. Missing required key.`,
      );
    }
    assertSchemaValue(
      nestedSchema,
      objectValue[key],
      `${path}.${key}`,
      allowUnknownKeys,
    );
  }
  if (allowUnknownKeys) return;
  for (const key of Object.keys(objectValue)) {
    if (!(key in schema)) {
      throw new Error(
        `Configurate: schema validation failed at '${path}.${key}'. Key is not declared in schema.`,
      );
    }
  }
}

export function assertDataMatchesSchema(
  schema: SchemaObject,
  data: unknown,
  allowUnknownKeys: boolean,
): void {
  assertSchemaObject(schema, data, "<root>", allowUnknownKeys);
}

function assertPartialSchemaValue(
  schemaValue: SchemaValue,
  value: unknown,
  path: string,
  allowUnknownKeys: boolean,
): void {
  const { schema: inner, isOptional } = unwrapOptional(schemaValue);
  if (isOptional && (value === undefined || value === null)) return;
  schemaValue = inner;

  if (isKeyringField(schemaValue)) {
    if (value === null) return;
    const primitiveSchema = keyringPrimitiveSchema(schemaValue);
    if (primitiveSchema !== undefined)
      assertPrimitiveValue(primitiveSchema, value, path);
    return;
  }
  if (
    schemaValue === String ||
    schemaValue === Number ||
    schemaValue === Boolean
  ) {
    assertPrimitiveValue(schemaValue, value, path);
    return;
  }
  if (isSchemaObject(schemaValue)) {
    assertPartialSchemaObject(schemaValue, value, path, allowUnknownKeys);
    return;
  }
  if (!isSchemaArray(schemaValue)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Unsupported schema node.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Expected array, got ${valueTypeLabel(value)}.`,
    );
  }
  const elementSchema = schemaValue[0];
  for (let idx = 0; idx < value.length; idx++) {
    assertSchemaValue(
      elementSchema,
      value[idx],
      `${path}[${idx}]`,
      allowUnknownKeys,
    );
  }
}

function assertPartialSchemaObject(
  schema: SchemaObject,
  value: unknown,
  path: string,
  allowUnknownKeys: boolean,
): void {
  if (!isPlainObject(value)) {
    throw new Error(
      `Configurate: schema validation failed at '${path}'. Expected object, got ${valueTypeLabel(value)}.`,
    );
  }
  const objectValue = value as Record<string, unknown>;
  for (const [key, providedValue] of Object.entries(objectValue)) {
    if (!(key in schema)) {
      if (allowUnknownKeys) continue;
      throw new Error(
        `Configurate: schema validation failed at '${path}.${key}'. Key is not declared in schema.`,
      );
    }
    assertPartialSchemaValue(
      schema[key],
      providedValue,
      `${path}.${key}`,
      allowUnknownKeys,
    );
  }
}

export function assertPartialDataMatchesSchema(
  schema: SchemaObject,
  data: unknown,
  allowUnknownKeys: boolean,
): void {
  assertPartialSchemaObject(schema, data, "<root>", allowUnknownKeys);
}

// ---------------------------------------------------------------------------
// Deep merge defaults and migration
// ---------------------------------------------------------------------------

export function deepMergeDefaults(
  data: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in result) || result[key] === undefined || result[key] === null) {
      result[key] = defaultValue;
    } else if (isPlainObject(result[key]) && isPlainObject(defaultValue)) {
      result[key] = deepMergeDefaults(
        result[key] as Record<string, unknown>,
        defaultValue as Record<string, unknown>,
      );
    }
  }
  return result;
}

export function applyMigrations<TData extends Record<string, unknown>>(
  data: TData,
  currentVersion: number,
  migrations: MigrationStep<TData>[],
): { result: TData; didMigrate: boolean } {
  let dataVersion =
    typeof data[CONFIGURATE_VERSION_KEY] === "number"
      ? (data[CONFIGURATE_VERSION_KEY] as number)
      : 0;

  if (dataVersion >= currentVersion) return { result: data, didMigrate: false };

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let result = data;
  while (dataVersion < currentVersion) {
    const migration = sorted.find((step) => step.version === dataVersion);
    if (!migration) {
      throw new Error(
        `Configurate: missing migration step for version ${dataVersion}.`,
      );
    }
    result = migration.up(result);
    dataVersion = migration.version + 1;
  }
  const stamped = {
    ...result,
    [CONFIGURATE_VERSION_KEY]: currentVersion,
  } as TData;
  return { result: stamped, didMigrate: true };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function assertNonEmptyId(ids: Set<string>, id: string): void {
  if (!id) throw new Error("Batch entry id must not be empty.");
  if (ids.has(id)) throw new Error(`Batch entry id '${id}' is duplicated.`);
  ids.add(id);
}

export function toBatchError(
  error: unknown,
  fallbackKind = "unknown",
): { kind: string; message: string } {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof (error as { kind: unknown }).kind === "string" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as { kind: string; message: string };
  }
  if (error instanceof Error)
    return { kind: fallbackKind, message: error.message };
  return { kind: fallbackKind, message: String(error) };
}
