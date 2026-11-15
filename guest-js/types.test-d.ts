// Compile-time assertions for the public types. Checked by
// `bunx tsc -p tsconfig.json`; never imported or executed, and excluded from
// the npm build (`tsconfig.build.json`).

import { defineConfig, keyring, optional } from "./schema";
import type { InferLocked, InferUnlocked } from "./schema";

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
