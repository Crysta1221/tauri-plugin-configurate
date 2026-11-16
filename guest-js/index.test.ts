import { afterEach, describe, expect, it, mock } from "bun:test";

type InvokeArgs = Record<string, unknown> | undefined;
type InvokeHandler = (command: string, args: InvokeArgs) => Promise<unknown>;

async function loadApi(invokeHandler: InvokeHandler) {
  const invokeMock = mock((command: string, args?: Record<string, unknown>) => {
    return invokeHandler(command, args);
  });

  mock.module("@tauri-apps/api/core", () => {
    return { invoke: invokeMock };
  });

  mock.module("@tauri-apps/api/event", () => ({
    listen: mock(() => Promise.resolve(() => {})),
  }));

  const mod = await import(`./index.ts?test=${Date.now()}-${Math.random()}`);
  return { ...mod, invokeMock };
}

afterEach(() => {
  mock.restore();
});

describe("Configurate batch error handling", () => {
  it("saveAll should keep per-entry failure when payload build fails", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command, args) => {
        if (command !== "plugin:configurate|save_all") {
          throw new Error(`unexpected command: ${command}`);
        }
        const payload = (args?.payload ?? {}) as {
          entries?: Array<{ id: string; payload: Record<string, unknown> }>;
        };
        expect(payload.entries?.length).toBe(1);
        expect(payload.entries?.[0]?.id).toBe("ok");
        return {
          results: {
            ok: { ok: true, data: null },
          },
        };
      },
    );

    const okSchema = defineConfig({ theme: String });
    const badSchema = defineConfig({
      token: keyring(String, { id: "api-token" }),
    });

    const okConfig = new Configurate({
      schema: okSchema,
      fileName: "ok.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const badConfig = new Configurate({
      schema: badSchema,
      fileName: "bad.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: {
        validateOnWrite: true,
      },
    });

    const result = await Configurate.saveAll([
      { id: "ok", config: okConfig, data: { theme: "dark" } },
      { id: "bad", config: badConfig, data: { token: "secret" } },
    ]).run();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.results.ok).toEqual({ ok: true, data: null });
    expect(result.results.bad?.ok).toBe(false);
    if (result.results.bad && !result.results.bad.ok) {
      expect(result.results.bad.error.kind).toBe("payload_build_failed");
    }
  });

  it("loadAll should report schema validation failures per entry", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command !== "plugin:configurate|load_all") {
        throw new Error(`unexpected command: ${command}`);
      }
      return {
        results: {
          app: {
            ok: true,
            data: { theme: 100 },
          },
        },
      };
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: {
        validateOnRead: true,
      },
    });

    const result = await Configurate.loadAll([{ id: "app", config }]).run();
    expect(result.results.app?.ok).toBe(false);
    if (result.results.app && !result.results.app.ok) {
      expect(result.results.app.error.kind).toBe("schema_validation");
    }
  });

  it("loadAll should report unlock failures per entry", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load_all") {
        return {
          results: {
            app: {
              ok: true,
              data: { token: null },
            },
          },
        };
      }
      if (command === "plugin:configurate|unlock") {
        throw new Error("unlock failed");
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ token: keyring(String, { id: "token" }) });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const result = await Configurate.loadAll([{ id: "app", config }])
      .unlockAll({ service: "svc", account: "acc" })
      .run();

    expect(result.results.app?.ok).toBe(false);
    if (result.results.app && !result.results.app.ok) {
      expect(result.results.app.error.kind).toBe("unlock_failed");
    }
  });

  it("loadAll should apply defaults and migrations before returning data", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load_all") {
          return {
            results: {
              app: {
                ok: true,
                data: { __configurate_version__: 0, theme: "dark" },
              },
            },
          };
        }
        if (command === "plugin:configurate|save") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" } as never,
      version: 1,
      migrations: [
        {
          version: 0,
          up: (data: Record<string, unknown>) => ({
            ...data,
            lang: "ja",
          }),
        },
      ],
    });

    const result = await Configurate.loadAll([{ id: "app", config }]).run();
    expect(result.results.app).toEqual({
      ok: true,
      data: {
        __configurate_version__: 1,
        theme: "dark",
        lang: "ja",
      },
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("Configurate validation", () => {
  it("should validate primitive keyring value type on write", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async () => {
        return null;
      },
    );

    const schema = defineConfig({
      secret: keyring(Number, { id: "numeric-secret" }),
    });

    const config = new Configurate({
      schema,
      fileName: "secret.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: {
        validateOnWrite: true,
      },
    });

    await expect(
      config
        .create({
          secret: "wrong-type",
        } as never)
        .lock({ service: "svc", account: "acc" })
        .run(),
    ).rejects.toThrow("Expected number");

    expect(invokeMock).toHaveBeenCalledTimes(0);
  });

  it("should keep write validation disabled by default for compatibility", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command !== "plugin:configurate|save") {
          throw new Error(`unexpected command: ${command}`);
        }
        return null;
      },
    );

    const schema = defineConfig({
      name: String,
    });

    const config = new Configurate({
      schema,
      fileName: "legacy.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const locked = await config.save({} as never).run();
    expect(locked.data).toEqual({});
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 1. defineConfig validation
// ---------------------------------------------------------------------------

describe("defineConfig validation", () => {
  it("should throw on duplicate keyring IDs", async () => {
    const { defineConfig, keyring } = await loadApi(async () => null);

    expect(() =>
      defineConfig({
        tokenA: keyring(String, { id: "dup" }),
        tokenB: keyring(String, { id: "dup" }),
      }),
    ).toThrow("Duplicate keyring id: 'dup'");
  });

  it("should throw on duplicate keyring IDs in nested schemas", async () => {
    const { defineConfig, keyring } = await loadApi(async () => null);

    expect(() =>
      defineConfig({
        top: keyring(String, { id: "shared" }),
        nested: {
          inner: keyring(String, { id: "shared" }),
        },
      }),
    ).toThrow("Duplicate keyring id: 'shared'");
  });

  it("should throw on invalid array schema (empty array)", async () => {
    const { defineConfig } = await loadApi(async () => null);

    expect(() => defineConfig({ tags: [] as never })).toThrow("Invalid array schema at 'tags'");
  });

  it("should throw on invalid array schema (more than one element)", async () => {
    const { defineConfig } = await loadApi(async () => null);

    expect(() => defineConfig({ tags: [String, Number] as never })).toThrow(
      "Invalid array schema at 'tags'",
    );
  });

  it("should throw on invalid array schema (optional or non-schema element)", async () => {
    const { defineConfig, optional } = await loadApi(async () => null);

    expect(() => defineConfig({ tags: [optional(String)] as never })).toThrow(
      "Invalid array schema at 'tags'",
    );
    expect(() => defineConfig({ tags: [new Date()] as never })).toThrow(
      "Invalid array schema at 'tags'",
    );
  });

  it("should accept valid array schema", async () => {
    const { defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ tags: [String] });
    expect(schema).toBeDefined();
    expect(schema.tags).toEqual([String]);
  });

  it("should accept valid nested object array schema", async () => {
    const { defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({
      items: [{ name: String, count: Number }],
    });
    expect(schema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Provider creation
// ---------------------------------------------------------------------------

describe("Provider creation", () => {
  it("JsonProvider should produce a json provider", async () => {
    const { JsonProvider } = await loadApi(async () => null);
    const provider = JsonProvider();
    expect(provider.kind).toBe("json");
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it("YmlProvider should produce a yml provider", async () => {
    const { YmlProvider } = await loadApi(async () => null);
    const provider = YmlProvider();
    expect(provider.kind).toBe("yml");
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it("BinaryProvider should produce a binary provider with kdf", async () => {
    const { BinaryProvider } = await loadApi(async () => null);
    const provider = BinaryProvider({ encryptionKey: "mykey", kdf: "argon2" });
    expect(provider.kind).toBe("binary");
    expect(provider.encryptionKey).toBe("mykey");
    expect(provider.kdf).toBe("argon2");
  });

  it("BinaryProvider without options should have undefined fields", async () => {
    const { BinaryProvider } = await loadApi(async () => null);
    const provider = BinaryProvider();
    expect(provider.kind).toBe("binary");
    expect(provider.encryptionKey).toBeUndefined();
    expect(provider.kdf).toBeUndefined();
  });

  it("isProvider should reject invalid kdf strings", async () => {
    const { BinaryProvider, isProvider } = await loadApi(async () => null);
    expect(isProvider(BinaryProvider())).toBe(true);
    expect(isProvider(BinaryProvider({ encryptionKey: "k", kdf: "sha256" }))).toBe(true);
    expect(isProvider(BinaryProvider({ encryptionKey: "k", kdf: "argon2" }))).toBe(true);
    expect(isProvider(BinaryProvider({ encryptionKey: "k", kdf: "pbkdf2" as never }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Single config operations
// ---------------------------------------------------------------------------

describe("Single config operations", () => {
  it("create().run() should invoke plugin:configurate|create with correct payload", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const result = await config.create({ theme: "dark", count: 5 } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|create");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.fileName).toBe("app.json");
    expect(payload.baseDir).toBe(13);
    expect((payload.provider as Record<string, unknown>).kind).toBe("json");
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
    expect((payload.data as Record<string, unknown>).count).toBe(5);
    expect(result.data).toEqual({ theme: "dark", count: 5 });
  });

  it("load().run() should invoke plugin:configurate|load and return LockedConfig", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: "light", count: 10 };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const locked = await config.load().run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(cmd).toBe("plugin:configurate|load");
    expect(locked.data).toEqual({ theme: "light", count: 10 });
  });

  it("save().run() should invoke plugin:configurate|save", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|save") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config.save({ theme: "dark" } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|save");
    const payload = args.payload as Record<string, unknown>;
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
  });

  it("delete() should invoke plugin:configurate|delete", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|delete") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config.delete();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|delete");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.fileName).toBe("app.json");
  });

  it("delete() should omit encryptionKey from IPC payload for binary provider", async () => {
    const { Configurate, BinaryProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|delete") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.bin",
      baseDir: 13 as never,
      provider: BinaryProvider({ encryptionKey: "secret", kdf: "argon2" }),
    });

    await config.delete();

    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    const provider = (args.payload as Record<string, unknown>).provider as Record<string, unknown>;
    expect(provider.encryptionKey).toBeUndefined();
  });

  it("exists() should invoke plugin:configurate|exists and return boolean", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|exists") return true;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const result = await config.exists();
    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(cmd).toBe("plugin:configurate|exists");
  });

  it("exportAs should serialize unlocked data when keyring opts are provided", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command, args) => {
        if (command === "plugin:configurate|load") {
          return { theme: "dark", token: null };
        }
        if (command === "plugin:configurate|unlock") {
          return { theme: "dark", token: "secret" };
        }
        if (command === "plugin:configurate|export_config") {
          const payload = (args?.payload ?? {}) as {
            source?: Record<string, unknown>;
            targetFormat?: string;
          };
          expect(payload.targetFormat).toBe("yml");
          expect(((payload.source || {}).data as Record<string, unknown>).token).toBe("secret");
          return "theme: dark\ntoken: secret\n";
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      theme: String,
      token: keyring(String, { id: "tok" }),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const result = await config.exportAs("yml", {
      service: "svc",
      account: "acc",
    });
    expect(result).toContain("token: secret");
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("importFrom should route keyring values through the import payload", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command, args) => {
        if (command === "plugin:configurate|import_config") {
          const payload = (args?.payload ?? {}) as {
            parseOnly?: boolean;
            target?: Record<string, unknown>;
          };
          if (payload.parseOnly) {
            return { theme: "dark", token: "secret" };
          }

          const target = payload.target ?? {};
          expect((target.data as Record<string, unknown>).token).toBeNull();
          const entries = target.keyringEntries as Array<{
            id: string;
            value: string;
          }>;
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            id: "tok",
            dotpath: "token",
            value: '"secret"',
          });
          const opts = target.keyringOptions as Record<string, unknown>;
          expect(opts.service).toBe("svc");
          expect(opts.account).toBe("acc");
          return null;
        }
        if (command === "plugin:configurate|load") {
          throw new Error("not found");
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      theme: String,
      token: keyring(String, { id: "tok" }),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config.importFrom('theme = "dark"\ntoken = "secret"\n', "toml", {
      service: "svc",
      account: "acc",
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("reset() should return an instance of LazyResetEntry", async () => {
    const { Configurate, JsonProvider, LazyResetEntry, defineConfig } = await loadApi(
      async () => null,
    );
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const entry = config.reset({ theme: "dark" });
    expect(entry).toBeInstanceOf(LazyResetEntry);
  });
});

// ---------------------------------------------------------------------------
// 4. Patch operation
// ---------------------------------------------------------------------------

describe("Patch operation", () => {
  it("patch().run() should invoke plugin:configurate|patch with partial data", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const patched = await config.patch({ theme: "dark" } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(patched.data).toEqual({ theme: "dark" });

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
    // count should not be present since it was not patched
    expect((payload.data as Record<string, unknown>).count).toBeUndefined();
  });

  it("patch().unlock() should invoke plugin:configurate|patch with withUnlock=true", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|patch") return { theme: "dark", count: 5 };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config.patch({ theme: "dark" } as never).unlock({
      service: "svc",
      account: "acc",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.withUnlock).toBe(true);
    expect(unlocked.data).toEqual({ theme: "dark", count: 5 });
  });

  it("patch().run() should not require lock when payload has no keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      token: keyring(String, { id: "api-token" }),
      theme: String,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const patched = await config.patch({ theme: "dark" } as never).run();
    expect(patched.data).toEqual({ theme: "dark" });

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringEntries).toBeUndefined();
    expect(payload.keyringOptions).toBeUndefined();
  });

  it("patch().run() should require lock when payload includes keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({
      token: keyring(String, { id: "api-token" }),
      theme: String,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await expect(config.patch({ token: "secret" } as never).run()).rejects.toThrow(
      "patch payload contains keyring fields",
    );
    expect(invokeMock).toHaveBeenCalledTimes(0);
  });

  it("patch() should validate only provided keys when validateOnWrite=true", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: {
        validateOnWrite: true,
      },
    });

    await config.patch({ theme: "dark" } as never).run();
    await expect(config.patch({ count: "invalid" } as never).run()).rejects.toThrow(
      "Expected number",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Default values
// ---------------------------------------------------------------------------

describe("Default values", () => {
  it("should merge defaults into loaded data for missing keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: "dark" };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" } as never,
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", lang: "en" });
  });

  it("should not overwrite existing keys with defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: "dark", lang: "fr" };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" } as never,
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", lang: "fr" });
  });

  it("should deep merge nested defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { ui: { theme: "dark" } };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ ui: { theme: String, fontSize: Number } });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { ui: { fontSize: 14 } } as never,
    });

    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).ui).toEqual({
      theme: "dark",
      fontSize: 14,
    });
  });

  it("should fill null values with defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: null };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { theme: "light" } as never,
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "light" });
  });
});

// ---------------------------------------------------------------------------
// 6. Migration
// ---------------------------------------------------------------------------

describe("Migration", () => {
  it("should apply migration when data version is older", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") {
        return { __configurate_version__: 0, theme: "dark" };
      }
      if (command === "plugin:configurate|save") {
        return null;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String, newField: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 1,
      migrations: [
        {
          version: 0,
          up: (data: Record<string, unknown>) => ({
            ...data,
            newField: "added",
          }),
        },
      ],
    });

    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).newField).toBe("added");
    expect((locked.data as Record<string, unknown>).__configurate_version__).toBe(1);
  });

  it("should not apply migration when data version matches current", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") {
        return { __configurate_version__: 2, theme: "dark" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 2,
      migrations: [
        {
          version: 1,
          up: (data: Record<string, unknown>) => ({
            ...data,
            shouldNotBeApplied: true,
          }),
        },
      ],
    });

    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).shouldNotBeApplied).toBeUndefined();
  });

  it("should apply multiple migrations in order", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") {
        return { __configurate_version__: 0, value: "a" };
      }
      if (command === "plugin:configurate|save") {
        return null;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ value: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 3,
      migrations: [
        {
          version: 0,
          up: (data: { value: string } & Record<string, unknown>) => ({
            ...data,
            value: data.value + "b",
          }),
        },
        {
          version: 1,
          up: (data: { value: string } & Record<string, unknown>) => ({
            ...data,
            value: data.value + "c",
          }),
        },
        {
          version: 2,
          up: (data: { value: string } & Record<string, unknown>) => ({
            ...data,
            value: data.value + "d",
          }),
        },
      ],
    });

    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).value).toBe("abcd");
    expect((locked.data as Record<string, unknown>).__configurate_version__).toBe(3);
  });

  it("should fail when a required migration step is missing", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") {
        return { __configurate_version__: 0, value: "a" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ value: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 2,
      migrations: [
        {
          version: 1,
          up: (data: { value: string } & Record<string, unknown>) => ({
            ...data,
            value: data.value + "c",
          }),
        },
      ],
    });

    await expect(config.load().run()).rejects.toThrow("missing migration step for version 0");
  });

  it("should stamp version on create when versioning is enabled", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 3,
    });

    await config.create({ theme: "dark" } as never).run();
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    const payload = args.payload as Record<string, unknown>;
    expect((payload.data as Record<string, unknown>).__configurate_version__).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. onChange
// ---------------------------------------------------------------------------

describe("onChange", () => {
  it("should set up a tauri event listener for configurate://change", async () => {
    let listenMock: ReturnType<typeof mock>;
    const unlistenFn = mock(() => {});

    const invokeMock = mock(async () => null);

    mock.module("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

    listenMock = mock((_event: string, _handler: unknown) => Promise.resolve(unlistenFn));
    mock.module("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));

    const mod = await import(`./index.ts?test=onchange-${Date.now()}-${Math.random()}`);
    const { Configurate, JsonProvider, defineConfig } = mod;

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "settings.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const callback = mock(() => {});
    const unlisten = await config.onChange(callback);

    expect(listenMock).toHaveBeenCalledTimes(1);
    const [eventName] = listenMock.mock.calls[0] as [string, unknown];
    expect(eventName).toBe("configurate://change");

    // The unlisten function should be returned
    expect(typeof unlisten).toBe("function");
  });

  it("should filter events by targetId", async () => {
    let capturedHandler:
      | ((event: { payload: { fileName: string; operation: string; targetId: string } }) => void)
      | null = null;
    const unlistenFn = mock(() => {});

    const invokeMock = mock(async () => null);
    mock.module("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

    const listenMock = mock((_event: string, handler: unknown) => {
      capturedHandler = handler as typeof capturedHandler;
      return Promise.resolve(unlistenFn);
    });
    mock.module("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));

    const mod = await import(`./index.ts?test=onchange-filter-${Date.now()}-${Math.random()}`);
    const { Configurate, JsonProvider, defineConfig } = mod;

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "settings.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const callback = mock(() => {});
    await config.onChange(callback);

    if (!capturedHandler) {
      throw new Error("event handler was not captured");
    }
    const handler = capturedHandler as (event: {
      payload: { fileName: string; operation: string; targetId: string };
    }) => void;

    // Simulate an event for a different config that happens to share the fileName.
    handler({
      payload: {
        fileName: "settings.json",
        operation: "save",
        targetId: "13|json|settings.json|nested|",
      },
    });
    expect(callback).toHaveBeenCalledTimes(0);

    // Simulate event for the correct file
    handler({
      payload: {
        fileName: "settings.json",
        operation: "save",
        targetId: "13|json|settings.json||",
      },
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Schema validation on read
// ---------------------------------------------------------------------------

describe("Schema validation on read", () => {
  it("should reject unknown keys when allowUnknownKeys is false", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: "dark", extra: true };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Key is not declared in schema");
  });

  it("should allow unknown keys when allowUnknownKeys is true", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: "dark", extra: true };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true, allowUnknownKeys: true },
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", extra: true });
  });

  it("should reject missing required keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return {};
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Missing required key");
  });

  it("should reject wrong type (expected string, got number)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { theme: 123 };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Expected string, got number");
  });

  it("should reject wrong type (expected number, got string)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { count: "not-a-number" };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Expected number, got string");
  });

  it("should reject wrong type (expected boolean, got string)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { enabled: "yes" };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ enabled: Boolean });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Expected boolean, got string");
  });

  it("should validate array elements on read", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { tags: ["a", "b", 3] };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ tags: [String] });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Expected string, got number");
  });

  it("should reject non-object where object is expected", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") return { ui: "not-an-object" };
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({ ui: { theme: String } });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Expected object, got string");
  });

  it("should pass validation when data matches schema", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (command) => {
      if (command === "plugin:configurate|load") {
        return { name: "test", count: 42, enabled: true };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const schema = defineConfig({
      name: String,
      count: Number,
      enabled: Boolean,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ name: "test", count: 42, enabled: true });
  });
});

// ---------------------------------------------------------------------------
// 9. Path validation
// ---------------------------------------------------------------------------

describe("Path validation", () => {
  it("should reject fileName with forward slash", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "sub/file.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("path separators");
  });

  it("should reject fileName with backslash", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "sub\\file.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("path separators");
  });

  it('should reject fileName "."', async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: ".",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("dot-only segments");
  });

  it('should reject fileName ".."', async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "..",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("dot-only segments");
  });

  it('should reject fileName "..."', async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "...",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("dot-only segments");
  });

  it("should reject fileName ending with a space", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app ",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("ending with a space or dot");
  });

  it("should reject dirName with empty segments", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
          options: { dirName: "a//b" },
        }),
    ).toThrow("empty segments");
  });

  it("should reject dirName with '.' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
          options: { dirName: "a/./b" },
        }),
    ).toThrow("dot-only segments");
  });

  it("should reject dirName with '..' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
          options: { dirName: "a/../b" },
        }),
    ).toThrow("dot-only segments");
  });

  it("should reject dirName with Windows-forbidden characters", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
          options: { dirName: "foo:bar" },
        }),
    ).toThrow("Windows-forbidden characters");
  });

  it("should reject currentPath with '..' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => null);

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
          options: { currentPath: "a/../b" },
        }),
    ).toThrow("dot-only segments");
  });

  it("should accept valid dirName and currentPath", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: "dark" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      options: { dirName: "my-app/configs", currentPath: "v2/settings" },
    });

    await config.load().run();
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    const payload = args.payload as Record<string, unknown>;
    const options = payload.options as Record<string, unknown>;
    expect(options.dirName).toBe("my-app/configs");
    expect(options.currentPath).toBe("v2/settings");
  });
});

// ---------------------------------------------------------------------------
// 10. Keyring field handling
// ---------------------------------------------------------------------------

describe("Keyring field handling", () => {
  it("separateSecrets should strip keyring values and produce entries on create", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          throw new Error("not found");
        }
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      theme: String,
      apiKey: keyring(String, { id: "api-key" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .create({ theme: "dark", apiKey: "secret-123" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|create");
    const payload = args.payload as Record<string, unknown>;

    // Plain data should have null for keyring fields
    expect((payload.data as Record<string, unknown>).apiKey).toBeNull();
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");

    // Keyring entries should contain the secret
    const entries = payload.keyringEntries as Array<{
      id: string;
      dotpath: string;
      value: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("api-key");
    expect(entries[0].dotpath).toBe("apiKey");
    expect(entries[0].value).toBe('"secret-123"');

    // Keyring options should be set
    const kOpts = payload.keyringOptions as Record<string, unknown>;
    expect(kOpts.service).toBe("svc");
    expect(kOpts.account).toBe("acc");
  });

  it("collectReadEntries should produce entries for unlock", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: "dark", apiKey: null };
        if (command === "plugin:configurate|unlock") return { theme: "dark", apiKey: "decrypted" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      theme: String,
      apiKey: keyring(String, { id: "api-key" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config.load().unlock({ service: "svc", account: "acc" });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // First call: load
    const [loadCmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(loadCmd).toBe("plugin:configurate|load");

    // Second call: unlock
    const [unlockCmd, unlockArgs] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(unlockCmd).toBe("plugin:configurate|unlock");
    const unlockPayload = unlockArgs.payload as Record<string, unknown>;
    const entries = unlockPayload.keyringEntries as Array<{
      id: string;
      dotpath: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("api-key");
    expect(entries[0].dotpath).toBe("apiKey");

    expect(unlocked.data).toEqual({ theme: "dark", apiKey: "decrypted" });
  });

  it("should throw when creating with keyring fields but no lock() call", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring } = await loadApi(async () => null);

    const schema = defineConfig({
      token: keyring(String, { id: "tok" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await expect(config.create({ token: "secret" } as never).run()).rejects.toThrow(
      "keyring fields",
    );
  });

  it("should handle nested keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      auth: {
        token: keyring(String, { id: "auth-token" }),
        refreshToken: keyring(String, { id: "refresh-token" }),
      },
      name: String,
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .create({
        auth: { token: "t1", refreshToken: "r1" },
        name: "test",
      } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|create");
    const payload = args.payload as Record<string, unknown>;
    const data = payload.data as {
      auth: Record<string, unknown>;
      name: string;
    };
    expect(data.auth.token).toBeNull();
    expect(data.auth.refreshToken).toBeNull();
    expect(data.name).toBe("test");

    const entries = payload.keyringEntries as Array<{
      id: string;
      dotpath: string;
      value: string;
    }>;
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["auth-token", "refresh-token"]);
  });

  it("should not unlock missing keyring under an optional parent object", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, optional, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|unlock") return {};
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      auth: optional({
        token: keyring(String, { id: "auth-token" }),
      }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config.load().unlock({ service: "svc", account: "acc" });
    expect(unlocked.data).toEqual({});
    expect(invokeMock).toHaveBeenCalledTimes(2);

    const [, unlockArgs] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    const unlockPayload = unlockArgs.payload as Record<string, unknown>;
    const entries = unlockPayload.keyringEntries as Array<{
      isOptional?: boolean;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isOptional).toBe(true);
  });

  it("should handle keyring in array schema (write entries)", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      tokens: [keyring(String, { id: "tok" })],
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .create({ tokens: ["secret1", "secret2"] } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|create");
    const payload = args.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    // Array elements should be nulled
    expect(data.tokens).toEqual([null, null]);

    const entries = payload.keyringEntries as Array<{
      id: string;
      dotpath: string;
      value: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0].value).toBe('"secret1"');
    expect(entries[1].value).toBe('"secret2"');
    // Array keyring entries should have encoded dotpath in their id
    expect(entries[0].dotpath).toBe("tokens.0");
    expect(entries[1].dotpath).toBe("tokens.1");
  });

  it("save should request stale optional keyring deletion on full replacement", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, optional, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") {
          return {};
        }
        if (command === "plugin:configurate|save") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      token: optional(keyring(String, { id: "tok" })),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .save({ theme: "dark" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|save");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringDeleteIds).toEqual(["tok"]);
    const opts = payload.keyringOptions as Record<string, unknown>;
    expect(opts.service).toBe("svc");
    expect(opts.account).toBe("acc");
  });

  it("save with optional keyring set to undefined omits write entry and still requests stale deletion", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, optional, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") {
          return { theme: "light", token: null };
        }
        if (command === "plugin:configurate|save") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      token: optional(keyring(String, { id: "tok" })),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .save({ theme: "dark", token: undefined })
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|save");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringEntries).toBeUndefined();
    expect(payload.keyringDeleteIds).toEqual(["tok"]);
    expect(payload.keyringOptions).toEqual({ service: "svc", account: "acc" });
  });

  it("reset should request stale optional keyring deletion on full replacement", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, optional, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") {
          return {};
        }
        if (command === "plugin:configurate|reset") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      token: optional(keyring(String, { id: "tok" })),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config
      .reset({ theme: "dark" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|reset");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringDeleteIds).toEqual(["tok"]);
  });

  it("keyring() should throw on empty id", async () => {
    const { keyring } = await loadApi(async () => null);
    expect(() => keyring(String, { id: "" })).toThrow("id must not be empty");
  });

  it("keyring() should throw when id contains '/'", async () => {
    const { keyring } = await loadApi(async () => null);
    expect(() => keyring(String, { id: "a/b" })).toThrow("must not contain '/'");
  });

  it("delete with keyring opts should include keyring entries", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|delete") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      token: keyring(String, { id: "tok" }),
      name: String,
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    await config.delete({ service: "svc", account: "acc" });

    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:configurate|delete");
    const payload = args.payload as Record<string, unknown>;
    const entries = payload.keyringEntries as Array<{
      id: string;
      dotpath: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("tok");
    const kOpts = payload.keyringOptions as Record<string, unknown>;
    expect(kOpts.service).toBe("svc");
    expect(kOpts.account).toBe("acc");
  });
});

// ---------------------------------------------------------------------------
// Migration edge cases
// ---------------------------------------------------------------------------

describe("Migration edge cases", () => {
  it("skips migrations whose version is already met", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(async () => ({
      value: "hello",
      __configurate_version__: 2,
    }));
    const schema = defineConfig({ value: String });
    const ran: number[] = [];
    const config = new Configurate({
      schema,
      fileName: "mig.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 2,
      migrations: [
        {
          version: 0,
          up: (d: Record<string, unknown>) => {
            ran.push(0);
            return d;
          },
        },
        {
          version: 1,
          up: (d: Record<string, unknown>) => {
            ran.push(1);
            return d;
          },
        },
      ],
    });
    await config.load().run();
    expect(ran).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("applies only migrations needed to reach current version", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => ({
      value: "a",
      __configurate_version__: 1,
    }));
    const schema = defineConfig({ value: String });
    const ran: number[] = [];
    const config = new Configurate({
      schema,
      fileName: "mig2.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 3,
      migrations: [
        {
          version: 0,
          up: (d: Record<string, unknown>) => {
            ran.push(0);
            return d;
          },
        },
        {
          version: 1,
          up: (d: Record<string, unknown>) => {
            ran.push(1);
            return d;
          },
        },
        {
          version: 2,
          up: (d: Record<string, unknown>) => {
            ran.push(2);
            return d;
          },
        },
      ],
    });
    const locked = await config.load().run();
    // Only versions 1 and 2 should run (data is already at version 1).
    expect(ran).toEqual([1, 2]);
    expect((locked.data as Record<string, unknown>).__configurate_version__).toBe(3);
  });

  it("version is stamped into write payload", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(async () => null);
    const schema = defineConfig({ label: String });
    const config = new Configurate({
      schema,
      fileName: "stamp.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      version: 5,
    });
    await config.save({ label: "hi" }).run();
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    const data = (args.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.__configurate_version__).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Default values edge cases
// ---------------------------------------------------------------------------

describe("Default values edge cases", () => {
  it("does not overwrite existing non-null values", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => ({
      count: 7,
      label: "existing",
    }));
    const schema = defineConfig({ count: Number, label: String });
    const config = new Configurate({
      schema,
      fileName: "def.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { count: 0, label: "default" },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).count).toBe(7);
    expect((locked.data as Record<string, unknown>).label).toBe("existing");
  });

  it("fills in missing top-level keys from defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => ({ count: 3 }));
    const schema = defineConfig({ count: Number, label: String });
    const config = new Configurate({
      schema,
      fileName: "def2.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { count: 0, label: "fallback" },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).label).toBe("fallback");
    expect((locked.data as Record<string, unknown>).count).toBe(3);
  });

  it("replaces null with default value", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => ({
      count: null,
    }));
    const schema = defineConfig({ count: Number });
    const config = new Configurate({
      schema,
      fileName: "def3.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { count: 42 },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).count).toBe(42);
  });

  it("deep-merges nested defaults without overwriting existing sub-keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => ({
      ui: { theme: "dark" },
    }));
    const schema = defineConfig({ ui: { theme: String, fontSize: Number } });
    const config = new Configurate({
      schema,
      fileName: "def4.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { ui: { theme: "light", fontSize: 14 } } as never,
    });
    const locked = await config.load().run();
    const ui = (locked.data as Record<string, unknown>).ui as Record<string, unknown>;
    expect(ui.theme).toBe("dark"); // existing value preserved
    expect(ui.fontSize).toBe(14); // missing key filled from defaults
  });
});

describe("configDiff", () => {
  it("throws when nesting exceeds maximum depth", async () => {
    const { configDiff } = await loadApi(async () => null);

    let oldNested: Record<string, unknown> = { value: 1 };
    let newNested: Record<string, unknown> = { value: 2 };
    for (let i = 0; i < 70; i++) {
      oldNested = { child: oldNested };
      newNested = { child: newNested };
    }

    expect(() => configDiff(oldNested, newNested)).toThrow(/maximum nesting depth exceeded/);
  });
});

describe("Write payloads", () => {
  const notFound = { kind: "io", message: "not found", io_kind: "not_found" };

  it("create/save/reset .run() do not ask Rust to echo the data back", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command) => {
        if (
          command === "plugin:configurate|create" ||
          command === "plugin:configurate|save" ||
          command === "plugin:configurate|reset"
        ) {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const created = await config.create({ theme: "a" }).run();
    const saved = await config.save({ theme: "b" }).run();
    const reset = await config.reset({ theme: "c" }).run();

    const calls = invokeMock.mock.calls as Array<[string, { payload: Record<string, unknown> }]>;
    expect(calls.map(([cmd]) => cmd)).toEqual([
      "plugin:configurate|create",
      "plugin:configurate|save",
      "plugin:configurate|reset",
    ]);
    for (const [, args] of calls) {
      expect(args.payload.returnData).toBe(false);
    }
    // The locked result still comes from the data that was sent.
    expect(created.data).toEqual({ theme: "a" });
    expect(saved.data).toEqual({ theme: "b" });
    expect(reset.data).toEqual({ theme: "c" });
  });

  it("lock().run() with keyring fields sends returnData false and returns locked data", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") throw notFound;
        if (command === "plugin:configurate|save") return null;
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const schema = defineConfig({ token: keyring(String, { id: "tok" }) });
    const config = new Configurate({
      schema,
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const locked = await config
      .save({ token: "secret" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const saveCall = (
      invokeMock.mock.calls as Array<[string, { payload: Record<string, unknown> }]>
    ).find(([cmd]) => cmd === "plugin:configurate|save");
    expect(saveCall?.[1].payload.returnData).toBe(false);
    expect(locked.data).toEqual({ token: null });
  });

  it("unlock paths still ask for the data because they return it", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") throw notFound;
        if (command === "plugin:configurate|create" || command === "plugin:configurate|reset") {
          return { token: "secret" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const schema = defineConfig({ token: keyring(String, { id: "tok" }) });
    const config = new Configurate({
      schema,
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const opts = { service: "svc", account: "acc" };

    const created = await config.create({ token: "secret" } as never).unlock(opts);
    const reset = await config.reset({ token: "secret" } as never).unlock(opts);

    const writes = (
      invokeMock.mock.calls as Array<[string, { payload: Record<string, unknown> }]>
    ).filter(([cmd]) => cmd !== "plugin:configurate|load");
    expect(writes).toHaveLength(2);
    for (const [, args] of writes) {
      expect(args.payload.returnData).toBe(true);
    }
    expect(created.data).toEqual({ token: "secret" });
    expect(reset.data).toEqual({ token: "secret" });
  });
});

describe("Configurate.list (static)", () => {
  it("sends a directory-level payload without fileName", async () => {
    const { Configurate, BinaryProvider, invokeMock } = await loadApi(async (command) => {
      if (command === "plugin:configurate|list_configs") return ["a.json"];
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await Configurate.list({
      baseDir: 13 as never,
      provider: BinaryProvider({ encryptionKey: "k", kdf: "argon2" }),
      options: { dirName: "sessions", currentPath: "2026" },
    });

    expect(files).toEqual(["a.json"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(cmd).toBe("plugin:configurate|list_configs");
    expect(args.payload).toEqual({
      baseDir: 13,
      // The encryption key never crosses IPC for a listing.
      provider: { kind: "binary", kdf: "argon2" },
      options: { dirName: "sessions", currentPath: "2026" },
      withUnlock: false,
      returnData: false,
    });
    expect("fileName" in args.payload).toBe(false);
  });

  it("omits options when no path option is set", async () => {
    const { Configurate, JsonProvider, invokeMock } = await loadApi(async () => []);
    await Configurate.list({ baseDir: 13 as never, provider: JsonProvider(), options: {} });
    const [, args] = invokeMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(args.payload).toEqual({
      baseDir: 13,
      provider: { kind: "json" },
      withUnlock: false,
      returnData: false,
    });
  });

  it("validates the location like the constructor", async () => {
    const { Configurate, JsonProvider, invokeMock } = await loadApi(async () => []);

    await expect(
      Configurate.list({
        baseDir: 13 as never,
        provider: JsonProvider(),
        options: { dirName: "a/../b" },
      }),
    ).rejects.toThrow(/dot-only segments/);
    await expect(
      Configurate.list({
        baseDir: 13 as never,
        provider: JsonProvider(),
        options: { currentPath: "a:b" },
      }),
    ).rejects.toThrow(/forbidden characters/);
    await expect(
      Configurate.list({ baseDir: undefined as never, provider: JsonProvider() }),
    ).rejects.toThrow(/"baseDir" must be provided/);
    await expect(
      Configurate.list({ baseDir: 13 as never, provider: { kind: "json" } as never }),
    ).rejects.toThrow(/provider must be created by/);
    expect(invokeMock).toHaveBeenCalledTimes(0);
  });

  it("instance list() keeps working alongside the static form", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(async () => [
      "x.json",
    ]);
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "x.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    expect(await config.list()).toEqual(["x.json"]);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(cmd).toBe("plugin:configurate|list_configs");
    expect(args.payload.fileName).toBe("x.json");
  });
});

describe("isNotFoundError", () => {
  it("is true only for the structured io/not_found error", async () => {
    const { isNotFoundError } = await loadApi(async () => null);

    expect(isNotFoundError({ kind: "io", message: "missing", io_kind: "not_found" })).toBe(true);
    expect(isNotFoundError({ kind: "io", message: "denied", io_kind: "permission_denied" })).toBe(
      false,
    );
    expect(isNotFoundError({ kind: "storage", message: "expected value at line 1" })).toBe(false);
    expect(isNotFoundError({ kind: "keyring", message: "No matching entry found" })).toBe(false);
    expect(isNotFoundError(new Error("not found"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError("not found")).toBe(false);
  });

  it("tells a missing file from a broken one through load() rejections", async () => {
    const { Configurate, JsonProvider, defineConfig, isNotFoundError } = await loadApi(
      async (_command, args) => {
        const payload = (args?.payload ?? {}) as { fileName?: string };
        if (payload.fileName === "missing.json") {
          throw { kind: "io", message: "No such file", io_kind: "not_found" };
        }
        throw { kind: "json", message: "EOF while parsing" };
      },
    );
    const make = (fileName: string) =>
      new Configurate({
        schema: defineConfig({ theme: String }),
        fileName,
        baseDir: 13 as never,
        provider: JsonProvider(),
      });

    const missing = await make("missing.json")
      .load()
      .run()
      .catch((e: unknown) => e);
    const broken = await make("broken.json")
      .load()
      .run()
      .catch((e: unknown) => e);
    expect(isNotFoundError(missing)).toBe(true);
    expect(isNotFoundError(broken)).toBe(false);
  });

  it("keeps io_kind in loadAll results", async () => {
    const { Configurate, JsonProvider, defineConfig, isNotFoundError } = await loadApi(
      async () => ({
        results: {
          a: { ok: false, error: { kind: "io", message: "missing", io_kind: "not_found" } },
        },
      }),
    );
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "a.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const result = await Configurate.loadAll([{ id: "a", config }]).run();
    const entry = result.results.a;
    expect(entry?.ok).toBe(false);
    if (entry && !entry.ok) expect(isNotFoundError(entry.error)).toBe(true);
  });
});

describe("Value markers: json() / record() / oneOf()", () => {
  async function setup(
    handler: InvokeHandler = async (command) => {
      if (command === "plugin:configurate|load") {
        throw { kind: "io", message: "missing", io_kind: "not_found" };
      }
      return null;
    },
  ) {
    const api = await loadApi(handler);
    const { defineConfig, json, record, oneOf, optional, keyring } = api;
    const schema = defineConfig({
      shape: json(),
      maybeShape: optional(json()),
      shortcuts: record(String),
      panes: record({ width: Number, tags: [String] }),
      maybePanes: optional(record({ width: Number })),
      theme: oneOf("light", "dark"),
      maybeTheme: optional(oneOf("a", "b")),
      shapes: [json()],
      maps: [record(Number)],
      themes: [oneOf("x", "y")],
      token: keyring(String, { id: "marker-token" }),
    });
    const config = new api.Configurate({
      schema,
      fileName: "markers.json",
      baseDir: 13 as never,
      provider: api.JsonProvider(),
      validation: { validateOnWrite: true, validateOnRead: true },
    });
    return { ...api, schema, config };
  }

  const KEYRING = { service: "svc", account: "acc" };
  const valid = () => ({
    shape: { kind: "rect", w: 1, h: [2, null, { deep: true }] },
    shortcuts: { save: "Ctrl+S" },
    panes: { left: { width: 200, tags: ["a"] } },
    theme: "dark",
    shapes: [{ kind: "circle" }, 1, "two", null],
    maps: [{ a: 1 }],
    themes: ["x", "y"],
    token: "secret",
  });

  it("accepts valid values, with optional markers absent or null", async () => {
    const { config } = await setup();
    expect(() => config.validate(valid() as never)).not.toThrow();
    expect(() =>
      config.validate({
        ...valid(),
        maybeShape: null,
        maybePanes: null,
        maybeTheme: null,
      } as never),
    ).not.toThrow();
    expect(() =>
      config.validate({
        ...valid(),
        maybeShape: [1],
        maybePanes: { a: { width: 1 } },
        maybeTheme: "b",
      } as never),
    ).not.toThrow();
  });

  it("rejects values that do not match a marker", async () => {
    const { config } = await setup();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ shape: undefined }, /'<root>.shape'. Expected JSON value, got undefined/],
      [{ shape: { at: new Date(0) } }, /'<root>.shape.at'. Expected JSON value, got object/],
      [{ shape: { n: Number.NaN } }, /'<root>.shape.n'. Expected JSON value, got non-finite/],
      [{ shape: [1, undefined] }, /'<root>.shape\[1\]'. Expected JSON value, got undefined/],
      [{ shape: () => 1 }, /Expected JSON value, got function/],
      [{ shape: 1n }, /Expected JSON value, got bigint/],
      [{ shortcuts: ["a"] }, /'<root>.shortcuts'. Expected object, got array/],
      [{ shortcuts: new Date() }, /'<root>.shortcuts'. Expected object, got object/],
      [{ shortcuts: { save: 1 } }, /'<root>.shortcuts.save'. Expected string, got number/],
      [{ panes: { left: { width: "1", tags: [] } } }, /'<root>.panes.left.width'. Expected number/],
      [{ panes: { left: { width: 1 } } }, /'<root>.panes.left.tags'. Missing required key/],
      [{ panes: { left: { width: 1, tags: [], extra: 1 } } }, /Key is not declared in schema/],
      [{ theme: "blue" }, /'<root>.theme'. Expected one of "light", "dark", got "blue"/],
      [{ theme: 1 }, /Expected one of "light", "dark", got number/],
      [{ maybeTheme: "c" }, /'<root>.maybeTheme'. Expected one of "a", "b"/],
      [{ shapes: [Symbol("s")] }, /'<root>.shapes\[0\]'. Expected JSON value, got symbol/],
      [{ maps: [{ a: "1" }] }, /'<root>.maps\[0\].a'. Expected number/],
      [{ themes: ["x", "z"] }, /'<root>.themes\[1\]'. Expected one of "x", "y"/],
    ];
    for (const [override, message] of cases) {
      expect(() => config.validate({ ...valid(), ...override } as never)).toThrow(message);
    }
    const missing = valid() as Record<string, unknown>;
    delete missing.theme;
    expect(() => config.validate(missing as never)).toThrow(/'<root>.theme'. Missing required key/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => config.validate({ ...valid(), shape: cyclic } as never)).toThrow(
      /circular reference/,
    );
    // Shared (non-cyclic) references are fine.
    const shared = { a: 1 };
    expect(() => config.validate({ ...valid(), shape: [shared, shared] } as never)).not.toThrow();
  });

  it("validates on write and keeps marker values out of the keyring", async () => {
    const { config, invokeMock } = await setup();
    await config
      .save(valid() as never)
      .lock(KEYRING)
      .run();

    const saveCall = (
      invokeMock.mock.calls as Array<[string, { payload: Record<string, unknown> }]>
    ).find(([cmd]) => cmd === "plugin:configurate|save");
    const payload = saveCall?.[1].payload as Record<string, unknown>;
    // Only the real keyring field is extracted; marker values stay on disk as-is.
    expect(payload.keyringEntries).toEqual([
      { id: "marker-token", dotpath: "token", value: '"secret"' },
    ]);
    expect(payload.data).toEqual({ ...valid(), token: null });

    await expect(
      config
        .save({ ...valid(), theme: "blue" } as never)
        .lock(KEYRING)
        .run(),
    ).rejects.toThrow(/Expected one of/);
  });

  it("validates on read and unlocks only the keyring field", async () => {
    const stored = { ...valid(), token: null };
    const { config, invokeMock } = await setup(async (command, args) => {
      if (command === "plugin:configurate|load") return structuredClone(stored);
      if (command === "plugin:configurate|unlock") {
        const payload = args?.payload as { data: Record<string, unknown> };
        return { ...payload.data, token: "secret" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const unlocked = await config.load().unlock(KEYRING);
    expect(unlocked.data).toEqual(valid());
    const unlockCall = (
      invokeMock.mock.calls as Array<[string, { payload: Record<string, unknown> }]>
    ).find(([cmd]) => cmd === "plugin:configurate|unlock");
    expect(unlockCall?.[1].payload.keyringEntries).toEqual([
      { id: "marker-token", dotpath: "token", value: "" },
    ]);
  });

  it("rejects broken data on read", async () => {
    const { config } = await setup(async () => ({ ...valid(), token: null, theme: "blue" }));
    await expect(config.load().run()).rejects.toThrow(/'<root>.theme'. Expected one of/);
  });

  it("validates patch data: record entries merge, other markers are checked whole", async () => {
    const { config, invokeMock } = await setup();
    // A record entry may be partial in a patch (Rust deep-merges it).
    await config.patch({ panes: { left: { width: 300 } } } as never).run();
    await config.patch({ theme: "light", shape: { any: ["thing"] } } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await expect(config.patch({ theme: "blue" } as never).run()).rejects.toThrow(/Expected one of/);
    await expect(
      config.patch({ panes: { left: { width: "wide" } } } as never).run(),
    ).rejects.toThrow(/'<root>.panes.left.width'. Expected number/);
    await expect(config.patch({ shortcuts: { save: null } } as never).run()).rejects.toThrow(
      /'<root>.shortcuts.save'. Expected string, got null/,
    );
    await expect(config.patch({ shape: [1, undefined] } as never).run()).rejects.toThrow(
      /Expected JSON value, got undefined/,
    );
    expect(
      config.validatePartial({
        maybeTheme: null,
        theme: undefined,
        __configurate_version__: 1,
      } as never),
    ).toBeUndefined();
    expect(() => config.validate(new Date() as never)).toThrow(
      /'<root>'. Expected object, got object/,
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("fills defaults for missing markers but never merges into a stored record or json value", async () => {
    const { Configurate, JsonProvider, defineConfig, json, record, oneOf } = await loadApi(
      async () => ({
        settings: { size: 1 },
        shortcuts: { open: "Ctrl+O" },
        shape: { kind: "circle", r: 1 },
      }),
    );
    const config = new Configurate({
      schema: defineConfig({
        settings: { size: Number, color: String },
        shortcuts: record(String),
        shape: json(),
        theme: oneOf("light", "dark"),
        extra: record(Number),
      }),
      fileName: "defaults.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: {
        settings: { size: 2, color: "red" },
        shortcuts: { save: "Ctrl+S" },
        shape: { kind: "rect", w: 1 },
        theme: "dark",
        extra: { a: 1 },
      },
      validation: { validateOnRead: true },
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({
      settings: { size: 1, color: "red" }, // plain objects still merge
      shortcuts: { open: "Ctrl+O" }, // stored map kept as a whole
      shape: { kind: "circle", r: 1 }, // stored json kept as a whole
      theme: "dark", // missing key filled
      extra: { a: 1 }, // missing record filled from defaults
    });
  });
});

describe("Value markers: nested defaults", () => {
  it("keeps optional and nested markers whole while merging the objects around them", async () => {
    const { Configurate, JsonProvider, defineConfig, json, record, optional } = await loadApi(
      async () => ({
        maybeMap: { kept: 1 },
        ui: { panes: { left: 100 }, layout: { kind: "grid" } },
      }),
    );
    const config = new Configurate({
      schema: defineConfig({
        maybeMap: optional(record(Number)),
        ui: { panes: record(Number), layout: json(), zoom: Number },
      }),
      fileName: "nested.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: {
        maybeMap: { added: 2 },
        ui: { panes: { right: 200 }, layout: { kind: "list", gap: 1 }, zoom: 1 },
      },
      validation: { validateOnRead: true },
    });
    const locked = await config.load().run();
    expect(locked.data).toEqual({
      maybeMap: { kept: 1 },
      ui: { panes: { left: 100 }, layout: { kind: "grid" }, zoom: 1 },
    });
  });
});

describe("Value markers: schema checks", () => {
  it("rejects keyring fields anywhere inside a record()", async () => {
    const { defineConfig, keyring, record } = await loadApi(async () => null);
    expect(() => defineConfig({ m: record(keyring(String, { id: "a" }) as never) })).toThrow(
      /'m.\*'. keyring\(\) fields are not supported inside record\(\)/,
    );
    expect(() =>
      defineConfig({ m: record({ inner: { secret: keyring(String, { id: "b" }) } }) }),
    ).toThrow(/'m.\*.inner.secret'. keyring\(\) fields are not supported inside record\(\)/);
    expect(() => defineConfig({ m: record([keyring(String, { id: "c" })]) as never })).toThrow(
      /'m.\*\[\]'. keyring\(\) fields are not supported/,
    );
    expect(() => defineConfig({ m: record(record({ s: keyring(String, { id: "d" }) })) })).toThrow(
      /'m.\*.\*.s'/,
    );
  });

  it("checks array and optional shapes inside a record()", async () => {
    const { defineConfig, optional, record } = await loadApi(async () => null);
    expect(() => defineConfig({ m: record({ list: [String, Number] as never }) })).toThrow(
      /Invalid array schema at 'm.\*.list'/,
    );
    expect(() => defineConfig({ m: record(optional(String) as never) })).toThrow(
      /record\(\) values cannot be optional/,
    );
  });

  it("the constructor applies the same checks", async () => {
    const { Configurate, JsonProvider, keyring, record } = await loadApi(async () => null);
    expect(
      () =>
        new Configurate({
          schema: { m: record({ s: keyring(String, { id: "e" }) }) } as never,
          fileName: "x.json",
          baseDir: 13 as never,
          provider: JsonProvider(),
        }),
    ).toThrow(/not supported inside record/);
  });

  it("oneOf() requires string values", async () => {
    const { oneOf } = await loadApi(async () => null);
    expect(() => (oneOf as (...v: unknown[]) => unknown)()).toThrow(/at least one value/);
    expect(() => (oneOf as (...v: unknown[]) => unknown)("a", 1)).toThrow(/must be strings/);
  });

  it("a keyring field beside markers keeps its static path and delete entry", async () => {
    const { Configurate, JsonProvider, defineConfig, json, record, keyring, invokeMock } =
      await loadApi(async () => null);
    const config = new Configurate({
      schema: defineConfig({
        meta: json(),
        map: record({ name: String }),
        nested: { secret: keyring(String, { id: "nested-secret" }), tags: record(String) },
      }),
      fileName: "k.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    await config.delete({ service: "svc", account: "acc" });
    const [, args] = invokeMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(args.payload.keyringEntries).toEqual([
      { id: "nested-secret", dotpath: "nested.secret", value: "" },
    ]);
  });
});

describe("Batch chunking", () => {
  type BatchArgs = {
    payload: { entries: Array<{ id: string; payload: Record<string, unknown> }> };
  };

  function batchCalls(invokeMock: { mock: { calls: unknown[][] } }, command: string) {
    return (invokeMock.mock.calls as Array<[string, BatchArgs]>).filter(([cmd]) => cmd === command);
  }

  const ids = (count: number) => Array.from({ length: count }, (_, i) => `e${i}`);

  it("loadAll splits more than 128 entries into consecutive calls and merges the results", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (command, args) => {
        expect(command).toBe("plugin:configurate|load_all");
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        const { entries } = (args as BatchArgs).payload;
        return {
          results: Object.fromEntries(
            entries.map((e) => [e.id, { ok: true, data: { theme: e.id } }]),
          ),
        };
      },
    );
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const all = ids(300);
    const result = await Configurate.loadAll(all.map((id) => ({ id, config }))).run();

    const calls = batchCalls(invokeMock, "plugin:configurate|load_all");
    expect(calls.map(([, a]) => a.payload.entries.length)).toEqual([128, 128, 44]);
    expect(calls.flatMap(([, a]) => a.payload.entries.map((e) => e.id))).toEqual(all);
    expect(maxInFlight).toBe(1);
    expect(Object.keys(result.results)).toHaveLength(300);
    expect(result.results.e299).toEqual({ ok: true, data: { theme: "e299" } });
  });

  it("exactly 128 entries still use one call", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (_command, args) => ({
        results: Object.fromEntries(
          (args as BatchArgs).payload.entries.map((e) => [e.id, { ok: true, data: null }]),
        ),
      }),
    );
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    await Configurate.saveAll(ids(128).map((id) => ({ id, config, data: { theme: id } }))).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate id across two chunks before any call", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(async () => ({
      results: {},
    }));
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const list = ids(200);
    list[150] = "e3";
    expect(() => Configurate.loadAll(list.map((id) => ({ id, config })))).toThrow(
      /Batch entry id 'e3' is duplicated/,
    );
    expect(() =>
      Configurate.patchAll(list.map((id) => ({ id, config, data: { theme: "x" } }))),
    ).toThrow(/duplicated/);
    expect(invokeMock).toHaveBeenCalledTimes(0);
  });

  it("reports a failing chunk per id and keeps the other chunks' results", async () => {
    let call = 0;
    const { Configurate, JsonProvider, defineConfig, invokeMock } = await loadApi(
      async (_command, args) => {
        call++;
        if (call === 2) throw "configurate.save_all not allowed";
        if (call === 3) throw { kind: "invalid_payload", message: "bad batch" };
        return {
          results: Object.fromEntries(
            (args as BatchArgs).payload.entries.map((e) => [e.id, { ok: true, data: null }]),
          ),
        };
      },
    );
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const result = await Configurate.saveAll(
      ids(300).map((id) => ({ id, config, data: { theme: id } })),
    ).run();

    expect(batchCalls(invokeMock, "plugin:configurate|save_all")).toHaveLength(3);
    expect(result.results.e0).toEqual({ ok: true, data: null });
    expect(result.results.e127).toEqual({ ok: true, data: null });
    expect(result.results.e128).toEqual({
      ok: false,
      error: { kind: "batch_call_failed", message: "configurate.save_all not allowed" },
    });
    expect(result.results.e255?.ok).toBe(false);
    expect(result.results.e256).toEqual({
      ok: false,
      error: { kind: "invalid_payload", message: "bad batch" },
    });
    expect(Object.keys(result.results)).toHaveLength(300);
  });

  it("a single-call batch still rejects when the call fails", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async () => {
      throw "configurate.patch_all not allowed";
    });
    const config = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    await expect(
      Configurate.patchAll([{ id: "a", config, data: { theme: "x" } }]).run(),
    ).rejects.toBe("configurate.patch_all not allowed");
  });

  it("keeps per-entry post-processing across chunks", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(async (_command, args) => ({
      results: Object.fromEntries(
        (args as BatchArgs).payload.entries.map((e) => [
          e.id,
          // e200 lives in the second chunk and has invalid data.
          { ok: true, data: e.id === "e200" ? { theme: 1 } : { theme: e.id } },
        ]),
      ),
    }));
    const config = new Configurate({
      schema: defineConfig({ theme: String, lang: String }),
      fileName: "s.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" },
      validation: { validateOnRead: true },
    });

    const result = await Configurate.loadAll(ids(260).map((id) => ({ id, config }))).run();
    expect(result.results.e0).toEqual({ ok: true, data: { theme: "e0", lang: "en" } });
    expect(result.results.e259).toEqual({ ok: true, data: { theme: "e259", lang: "en" } });
    const broken = result.results.e200;
    expect(broken?.ok).toBe(false);
    if (broken && !broken.ok) expect(broken.error.kind).toBe("schema_validation");
  });

  it("saveAll keeps preflight failures beside chunked results", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async (_command, args) => ({
        results: Object.fromEntries(
          (args as BatchArgs).payload.entries.map((e) => [e.id, { ok: true, data: null }]),
        ),
      }),
    );
    const plain = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "p.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const secret = new Configurate({
      schema: defineConfig({ token: keyring(String, { id: "tok" }) }),
      fileName: "k.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const entries = ids(130).map((id) => ({ id, config: plain, data: { theme: id } as unknown }));
    entries.push({ id: "secret", config: secret, data: { token: "t" } });

    const result = await Configurate.saveAll(entries).run();
    const calls = batchCalls(invokeMock, "plugin:configurate|save_all");
    expect(calls.map(([, a]) => a.payload.entries.length)).toEqual([128, 2]);
    expect(result.results.e129).toEqual({ ok: true, data: null });
    const failed = result.results.secret;
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) expect(failed.error.kind).toBe("payload_build_failed");
  });

  it("saveAll with > 128 total entries reduced to <= 128 by preflight failures still merges batch_call_failed", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async () => {
        throw "save_all backend failed";
      },
    );
    const plain = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "p.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const secret = new Configurate({
      schema: defineConfig({ token: keyring(String, { id: "tok" }) }),
      fileName: "k.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const entries = [
      ...ids(120).map((id) => ({ id, config: plain, data: { theme: id } as unknown })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `bad${i}`,
        config: secret,
        data: { token: "t" } as unknown,
      })),
    ];

    const result = await Configurate.saveAll(entries).run();
    expect(batchCalls(invokeMock, "plugin:configurate|save_all")).toHaveLength(1);
    expect(Object.keys(result.results)).toHaveLength(130);
    expect(result.results.e0).toEqual({
      ok: false,
      error: { kind: "batch_call_failed", message: "save_all backend failed" },
    });
    expect(result.results.e119).toEqual({
      ok: false,
      error: { kind: "batch_call_failed", message: "save_all backend failed" },
    });
    const preflight = result.results.bad0;
    expect(preflight?.ok).toBe(false);
    if (preflight && !preflight.ok) expect(preflight.error.kind).toBe("payload_build_failed");
  });

  it("patchAll with > 128 total entries reduced to <= 128 by preflight failures still merges batch_call_failed", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } = await loadApi(
      async () => {
        throw "patch_all backend failed";
      },
    );
    const plain = new Configurate({
      schema: defineConfig({ theme: String }),
      fileName: "p.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });
    const secret = new Configurate({
      schema: defineConfig({ token: keyring(String, { id: "tok" }) }),
      fileName: "k.json",
      baseDir: 13 as never,
      provider: JsonProvider(),
    });

    const entries = [
      ...ids(120).map((id) => ({ id, config: plain, data: { theme: id } as unknown })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `bad${i}`,
        config: secret,
        data: { token: "t" } as unknown,
      })),
    ];

    const result = await Configurate.patchAll(entries).run();
    expect(batchCalls(invokeMock, "plugin:configurate|patch_all")).toHaveLength(1);
    expect(Object.keys(result.results)).toHaveLength(130);
    expect(result.results.e0).toEqual({
      ok: false,
      error: { kind: "batch_call_failed", message: "patch_all backend failed" },
    });
    expect(result.results.e119).toEqual({
      ok: false,
      error: { kind: "batch_call_failed", message: "patch_all backend failed" },
    });
    const preflight = result.results.bad9;
    expect(preflight?.ok).toBe(false);
    if (preflight && !preflight.ok) expect(preflight.error.kind).toBe("payload_build_failed");
  });
});
