// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderBrand = { readonly __configurateProviderBrand: true };

export type KeyDerivation = "sha256" | "argon2";

type ProviderPayload =
  | { kind: "json" }
  | { kind: "yml" }
  | { kind: "toml" }
  | { kind: "binary"; encryptionKey?: string; kdf?: KeyDerivation }
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

export function isProvider(input: unknown): input is ConfigurateProvider {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const value = input as Record<string, unknown>;
  if (value[PROVIDER_BRAND_KEY] !== true) {
    return false;
  }
  const kind = value.kind;
  return (
    kind === "json" ||
    kind === "yml" ||
    kind === "toml" ||
    kind === "binary" ||
    kind === "sqlite"
  );
}

export function JsonProvider(): ConfigurateProvider {
  return createProvider({ kind: "json" });
}

export function YmlProvider(): ConfigurateProvider {
  return createProvider({ kind: "yml" });
}

/**
 * Creates a TOML file storage provider.
 *
 * **⚠ Null-field behaviour**
 * TOML has no native `null` type.  When a config object is saved, any field
 * whose value is `null` is **silently omitted** from the TOML file.  On the
 * next `load()`, that key will be absent from the returned data.
 *
 * Use `optional()` schema fields to model nullable values, and rely on the
 * `defaults` option in `Configurate` to supply fallback values on read.
 * Setting a non-optional field to `null` and saving it will cause that field
 * to disappear on the next load.
 */
export function TomlProvider(): ConfigurateProvider {
  return createProvider({ kind: "toml" });
}

export function BinaryProvider(opts?: {
  encryptionKey?: string;
  kdf?: KeyDerivation;
}): ConfigurateProvider {
  return createProvider({
    kind: "binary",
    encryptionKey: opts?.encryptionKey,
    kdf: opts?.kdf,
  });
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

