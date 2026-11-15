// Compile-time assertions for the public types. Checked by
// `bunx tsc -p tsconfig.json`; never imported or executed, and excluded from
// the npm build (`tsconfig.build.json`).

import { defineConfig, keyring, optional } from "./schema";
import type { InferLocked, InferUnlocked } from "./schema";
import { isNotFoundError } from "./configurate";
import type { BatchRunEntryResult, ConfigurateError, ConfigurateErrorKind } from "./configurate";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---------------------------------------------------------------------------
// optional() infers an optional key at every depth
// ---------------------------------------------------------------------------

const optionalSchema = defineConfig({
  theme: String,
  fontSize: optional(Number),
  proxy: optional({ host: String, port: optional(Number) }),
  nested: { label: optional(String), flag: Boolean },
  items: [{ name: String, note: optional(String) }],
  tags: optional([String]),
});

export type OptionalTests = [
  Expect<
    Equal<
      InferUnlocked<typeof optionalSchema>,
      {
        theme: string;
        fontSize?: number | undefined;
        proxy?: { host: string; port?: number | undefined } | undefined;
        nested: { label?: string | undefined; flag: boolean };
        items: { name: string; note?: string | undefined }[];
        tags?: string[] | undefined;
      }
    >
  >,
  Expect<
    Equal<
      InferLocked<typeof optionalSchema>,
      {
        theme: string;
        fontSize?: number | undefined;
        proxy?: { host: string; port?: number | undefined } | undefined;
        nested: { label?: string | undefined; flag: boolean };
        items: { name: string; note?: string | undefined }[];
        tags?: string[] | undefined;
      }
    >
  >,
];

// Object literals may omit optional keys.
export const omitsOptionalKeys: InferUnlocked<typeof optionalSchema> = {
  theme: "dark",
  nested: { flag: true },
  items: [{ name: "a" }],
};

// Reading still yields `T | undefined`.
export const readsOptionalKey: number | undefined = omitsOptionalKeys.fontSize;

// Required keys are still required.
// @ts-expect-error -- `theme` is missing
export const missingRequiredKey: InferUnlocked<typeof optionalSchema> = {
  nested: { flag: true },
  items: [],
};

// An optional keyring field is an optional key too (null while locked).
const secretSchema = defineConfig({
  token: optional(keyring(String, { id: "token" })),
});

export type OptionalKeyringTests = [
  Expect<Equal<InferLocked<typeof secretSchema>, { token?: null | undefined }>>,
];

export const omitsOptionalKeyring: InferUnlocked<typeof secretSchema> = {};

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

// Known kinds autocomplete; other strings stay accepted (not a breaking change).
export const knownKind: ConfigurateErrorKind = "schema_validation";
export const futureKind: ConfigurateErrorKind = "some_future_kind";

type BatchError = Extract<BatchRunEntryResult, { ok: false }>["error"];
export type ErrorShapeTests = [
  Expect<Equal<BatchError, ConfigurateError>>,
  Expect<Equal<BatchError["kind"], ConfigurateErrorKind>>,
  // Existing code that reads `kind` as a string keeps compiling.
  Expect<BatchError["kind"] extends string ? true : false>,
];

export function narrowsNotFound(error: unknown): "not_found" | undefined {
  if (isNotFoundError(error)) {
    const kind: "io" = error.kind;
    void kind;
    return error.io_kind;
  }
  return undefined;
}
