// Compile-time assertions for the public types. Checked by
// `bunx tsc -p tsconfig.json`; never imported or executed, and excluded from
// the npm build (`tsconfig.build.json`).

import { defineConfig, json, keyring, oneOf, optional, record } from "./schema";
import type { CollectKeyringIds, InferLocked, InferUnlocked, SchemaObject } from "./schema";
import { isNotFoundError } from "./configurate";
import type {
  BatchRunEntryResult,
  Configurate,
  ConfigurateError,
  ConfigurateErrorKind,
} from "./configurate";

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

// ---------------------------------------------------------------------------
// json() / record() / oneOf()
// ---------------------------------------------------------------------------

type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };

const markerSchema = defineConfig({
  anything: json(),
  shape: json<Shape>(),
  shortcuts: record(String),
  panes: record({ width: Number, pinned: optional(Boolean) }),
  nestedMap: record(record(oneOf("x", "y"))),
  listMap: record([Number]),
  theme: oneOf("light", "dark", "system"),
  maybeShape: optional(json<Shape>()),
  maybeMap: optional(record(Boolean)),
  maybeTheme: optional(oneOf("a", "b")),
  shapes: [json<Shape>()],
  maps: [record(String)],
  themes: [oneOf("light", "dark")],
  token: keyring(String, { id: "marker-token" }),
});

type MarkerData = InferUnlocked<typeof markerSchema>;

export type MarkerTests = [
  Expect<Equal<MarkerData["anything"], unknown>>,
  Expect<Equal<MarkerData["shape"], Shape>>,
  // A record of String is a map, not an object with a `_schema` key.
  Expect<Equal<MarkerData["shortcuts"], Record<string, string>>>,
  Expect<
    Equal<MarkerData["panes"], Record<string, { width: number; pinned?: boolean | undefined }>>
  >,
  Expect<Equal<MarkerData["nestedMap"], Record<string, Record<string, "x" | "y">>>>,
  Expect<Equal<MarkerData["listMap"], Record<string, number[]>>>,
  Expect<Equal<MarkerData["theme"], "light" | "dark" | "system">>,
  Expect<Equal<MarkerData["maybeShape"], Shape | undefined>>,
  Expect<Equal<MarkerData["maybeMap"], Record<string, boolean> | undefined>>,
  Expect<Equal<MarkerData["maybeTheme"], "a" | "b" | undefined>>,
  Expect<Equal<MarkerData["shapes"], Shape[]>>,
  Expect<Equal<MarkerData["maps"], Record<string, string>[]>>,
  Expect<Equal<MarkerData["themes"], ("light" | "dark")[]>>,
  // Same inference when locked; markers never become null.
  Expect<Equal<InferLocked<typeof markerSchema>["shape"], Shape>>,
  Expect<Equal<InferLocked<typeof markerSchema>["token"], null>>,
];

// Markers are never walked as nested objects for keyring ids.
const markerOnlySchema = defineConfig({
  map: record({ name: String }),
  maybeMap: optional(record(String)),
  value: json(),
  choice: oneOf("a"),
});
export type MarkerKeyringIdTests = [
  Expect<Equal<CollectKeyringIds<typeof markerOnlySchema>, never>>,
];

export const markerValue: InferUnlocked<typeof markerSchema> = {
  anything: { free: ["form", 1, null] },
  shape: { kind: "rect", w: 1, h: 2 },
  shortcuts: { save: "Ctrl+S" },
  panes: { left: { width: 200 } },
  nestedMap: {},
  listMap: { a: [1, 2] },
  theme: "dark",
  shapes: [],
  maps: [{ a: "b" }],
  themes: ["light"],
  token: "secret",
};

// @ts-expect-error -- not one of the allowed strings
export const rejectsOtherTheme: MarkerData["theme"] = "blue";

// @ts-expect-error -- keyring fields are not allowed as record values
export const keyringInRecord = record(keyring(String, { id: "k" }));

// @ts-expect-error -- oneOf() needs at least one value
export const emptyOneOf = oneOf();

// The wide schema type still instantiates (generic helpers rely on it).
export type WideSchema = [
  InferUnlocked<SchemaObject>,
  InferLocked<SchemaObject>,
  ReturnType<Configurate<SchemaObject>["validate"]>,
];
