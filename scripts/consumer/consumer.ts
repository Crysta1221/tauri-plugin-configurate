// Type-checked against the built `dist-js` declarations (see scripts/check-dist-types.mjs), never executed.
// Everything is used as a value, so a declaration that exports a runtime export as type-only fails here.
import {
  BaseDirectory,
  Configurate,
  LazyConfigEntry,
  LazyPatchEntry,
  LazyResetEntry,
  LockedConfig,
  PatchedConfig,
  UnlockedConfig,
  configDiff,
  defineConfig,
  isNotFoundError,
  json,
  keyring,
  oneOf,
  optional,
  record,
} from "tauri-plugin-configurate-api";
import type {
  BatchRunResult,
  ConfigurateError,
  ConfigurateErrorKind,
  ConfigurateIoErrorKind,
  ConfigurateListOptions,
  DiffEntry,
  InferLocked,
  InferUnlocked,
  KeyringOptions,
} from "tauri-plugin-configurate-api";
import {
  BinaryProvider,
  JsonProvider,
  TomlProvider,
  YmlProvider,
  isProvider,
} from "tauri-plugin-configurate-api/provider";
import type { ConfigurateProvider, KeyDerivation } from "tauri-plugin-configurate-api/provider";

const dir: BaseDirectory = BaseDirectory.AppConfig;
const kdf: KeyDerivation = "argon2";
const provider: ConfigurateProvider = JsonProvider();
const providers: ConfigurateProvider[] = [
  provider,
  YmlProvider(),
  TomlProvider(),
  BinaryProvider({ encryptionKey: "secret", kdf }),
];
const providerValid: boolean = isProvider(provider);

const schema = defineConfig({
  theme: oneOf("light", "dark"),
  size: optional(Number),
  extra: json<{ a: number }>(),
  labels: record(String),
  token: keyring(String, { id: "tok" }),
});

const unlockedToken: string = ({} as InferUnlocked<typeof schema>).token;
const lockedData: InferLocked<typeof schema> = {
  theme: "light",
  extra: { a: 1 },
  labels: { env: "prod" },
  token: null,
};
const unlockedData: InferUnlocked<typeof schema> = {
  theme: "light",
  extra: { a: 1 },
  labels: { env: "prod" },
  token: unlockedToken,
};

const config = new Configurate({ schema, fileName: "app.json", baseDir: dir, provider });
const listOpts: ConfigurateListOptions = { baseDir: dir, provider };
const names: Promise<string[]> = Configurate.list(listOpts);
const keyringOpts: KeyringOptions = { service: "app", account: "user" };

const entry: LazyConfigEntry<typeof schema> = config.load();
const locked: Promise<LockedConfig<typeof schema>> = entry.run();
const unlocked: Promise<UnlockedConfig<typeof schema>> = config.load().unlock(keyringOpts);
const patchEntry: LazyPatchEntry<typeof schema> = config.patch({ size: 12 });
const patched: Promise<PatchedConfig<typeof schema>> = patchEntry.createIfMissing().run();
const resetEntry: LazyResetEntry<typeof schema> = config.reset(unlockedData);
const batch: Promise<BatchRunResult> = Configurate.loadAll([{ id: "main", config }]).run();

const constructors = [
  Configurate,
  LazyConfigEntry,
  LazyPatchEntry,
  LazyResetEntry,
  LockedConfig,
  PatchedConfig,
  UnlockedConfig,
];
const probe: unknown = null;
const instanceChecks: boolean[] = [
  probe instanceof Configurate,
  probe instanceof LazyConfigEntry,
  probe instanceof LazyPatchEntry,
  probe instanceof LazyResetEntry,
  probe instanceof LockedConfig,
  probe instanceof PatchedConfig,
  probe instanceof UnlockedConfig,
];

const diff: DiffEntry[] = configDiff({ theme: "light" }, { theme: "dark" });
const errorKind: ConfigurateErrorKind = "io";
const ioKind: ConfigurateIoErrorKind = "not_found";
const errorShape: ConfigurateError = { kind: errorKind, message: "missing", io_kind: ioKind };
const notFound: boolean = isNotFoundError(errorShape);
const errCheck: boolean = isNotFoundError(new Error("x"));

export {
  batch,
  config,
  constructors,
  diff,
  errCheck,
  errorShape,
  instanceChecks,
  locked,
  lockedData,
  names,
  notFound,
  patched,
  providerValid,
  providers,
  resetEntry,
  unlocked,
};
