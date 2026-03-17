import {
  KEYRING_BRAND_KEY,
  KEYRING_RUNTIME_TYPE_KEY,
  OPTIONAL_BRAND_KEY,
  collectKeyringIds,
  isPrimitiveConstructor,
  validateSchemaArrays,
} from "./schema-utils";

// ---------------------------------------------------------------------------
// Keyring marker types
// ---------------------------------------------------------------------------

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
  typeCtor: abstract new (...args: never[]) => T | ((...args: never[]) => T),
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
  const field = { _type: undefined as unknown as T, _id: opts.id } as Record<
    string,
    unknown
  >;
  field[KEYRING_BRAND_KEY] = true;
  if (isPrimitiveConstructor(typeCtor)) {
    field[KEYRING_RUNTIME_TYPE_KEY] = typeCtor;
  }
  return field as KeyringField<T, Id>;
}

// ---------------------------------------------------------------------------
// Optional field marker types
// ---------------------------------------------------------------------------

/** Phantom symbol used only in the type system – never appears at runtime. */
declare const _optionalBrandTag: unique symbol;

/** The set of non-optional schema values that `optional()` can wrap. */
type OptionalInner =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject
  | SchemaArray;

/**
 * Marker type produced by `optional()`.
 * `V` – the wrapped schema value type.
 */
export type OptionalField<V extends OptionalInner> = {
  readonly [_optionalBrandTag]: true;
  readonly _schema: V;
};

/**
 * Marks a schema field as optional.
 *
 * An optional field may be absent from the stored config object.  Validation
 * (`validateOnRead` / `validateOnWrite`) will not fail when the field is
 * missing.  When absent the inferred TypeScript type includes `undefined`.
 *
 * @example
 * const schema = defineConfig({
 *   theme: String,                      // required string
 *   fontSize: optional(Number),         // optional number
 *   proxy: optional({ host: String }),  // optional nested object
 * });
 */
export function optional<V extends OptionalInner>(schema: V): OptionalField<V> {
  const field = { _schema: schema } as Record<string, unknown>;
  field[OPTIONAL_BRAND_KEY] = true;
  return field as unknown as OptionalField<V>;
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

type PrimitiveConstructor =
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor;

type InferPrimitive<C> = C extends StringConstructor
  ? string
  : C extends NumberConstructor
    ? number
    : C extends BooleanConstructor
      ? boolean
      : never;

type SchemaArrayElement =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject;

export type SchemaArray = readonly [SchemaArrayElement];

export type SchemaValue =
  | PrimitiveConstructor
  | KeyringField<unknown, string>
  | SchemaObject
  | SchemaArray
  | OptionalField<OptionalInner>;

export type SchemaObject = { [key: string]: SchemaValue };

// ---------------------------------------------------------------------------
// Type-level keyring id collection (used for duplicate detection)
// ---------------------------------------------------------------------------

export type CollectKeyringIds<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends KeyringField<unknown, infer Id>
    ? Id
    : S[K] extends OptionalField<infer V>
      ? V extends KeyringField<unknown, infer Id>
        ? Id
        : V extends SchemaObject
          ? CollectKeyringIds<V>
          : never
      : S[K] extends SchemaObject
        ? CollectKeyringIds<S[K]>
        : never;
}[keyof S];

type IsDuplicate<T extends string, All extends string> =
  T extends Exclude<All, T> ? true : false;

export type HasDuplicateKeyringIds<S extends SchemaObject> = true extends {
  [Id in CollectKeyringIds<S>]: IsDuplicate<Id, CollectKeyringIds<S>>;
}[CollectKeyringIds<S>]
  ? true
  : false;

// ---------------------------------------------------------------------------
// Type inference (locked = keyring fields replaced with null)
// ---------------------------------------------------------------------------

/** Infers the locked (keyring fields = null) TypeScript type from a SchemaObject. */
export type InferLocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends OptionalField<infer V>
    ?
        | (V extends KeyringField<unknown, string>
            ? null
            : V extends SchemaArray
              ? V[0] extends KeyringField<unknown, string>
                ? null[]
                : V[0] extends PrimitiveConstructor
                  ? InferPrimitive<V[0]>[]
                  : V[0] extends SchemaObject
                    ? InferLocked<V[0]>[]
                    : never
              : V extends SchemaObject
                ? InferLocked<V>
                : V extends PrimitiveConstructor
                  ? InferPrimitive<V>
                  : never)
        | undefined
    : S[K] extends KeyringField<unknown, string>
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

/** Infers the unlocked (keyring fields = actual type) TypeScript type from a SchemaObject. */
export type InferUnlocked<S extends SchemaObject> = {
  [K in keyof S]: S[K] extends OptionalField<infer V>
    ?
        | (V extends KeyringField<infer T, string>
            ? T
            : V extends SchemaArray
              ? V[0] extends KeyringField<infer T, string>
                ? T[]
                : V[0] extends PrimitiveConstructor
                  ? InferPrimitive<V[0]>[]
                  : V[0] extends SchemaObject
                    ? InferUnlocked<V[0]>[]
                    : never
              : V extends SchemaObject
                ? InferUnlocked<V>
                : V extends PrimitiveConstructor
                  ? InferPrimitive<V>
                  : never)
        | undefined
    : S[K] extends KeyringField<infer T, string>
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

// ---------------------------------------------------------------------------
// Migration step (lives here so schema-utils.ts can import it without routing
// through the re-export barrel in index.ts → configurate.ts)
// ---------------------------------------------------------------------------

/** A single migration step that transforms config data from one version to the next. */
export interface MigrationStep<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The version this migration upgrades FROM. */
  version: number;
  /** Transform function. Receives data at `version`, must return data at `version+1`. */
  up: (data: TData) => TData;
}
