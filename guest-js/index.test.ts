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
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command, args) => {
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
      });

    const okSchema = defineConfig({ theme: String });
    const badSchema = defineConfig({
      token: keyring(String, { id: "api-token" }),
    });

    const okConfig = new Configurate({
      schema: okSchema,
      fileName: "ok.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const badConfig = new Configurate({
      schema: badSchema,
      fileName: "bad.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
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
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig, keyring } = await loadApi(
      async (command) => {
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
      },
    );

    const schema = defineConfig({ token: keyring(String, { id: "token" }) });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
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
      });

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async () => {
        return null;
      });

    const schema = defineConfig({
      secret: keyring(Number, { id: "numeric-secret" }),
    });

    const config = new Configurate({
      schema,
      fileName: "secret.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command !== "plugin:configurate|save") {
          throw new Error(`unexpected command: ${command}`);
        }
        return null;
      });

    const schema = defineConfig({
      name: String,
    });

    const config = new Configurate({
      schema,
      fileName: "legacy.json",
      baseDir: 8 as never,
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

    expect(() => defineConfig({ tags: [] as never })).toThrow(
      "Invalid array schema at 'tags'",
    );
  });

  it("should throw on invalid array schema (more than one element)", async () => {
    const { defineConfig } = await loadApi(async () => null);

    expect(() => defineConfig({ tags: [String, Number] as never })).toThrow(
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

  it("SqliteProvider should use defaults when no options given", async () => {
    const { SqliteProvider } = await loadApi(async () => null);
    const provider = SqliteProvider();
    expect(provider.kind).toBe("sqlite");
    expect(provider.dbName).toBe("configurate.db");
    expect(provider.tableName).toBe("configurate_configs");
  });

  it("SqliteProvider should accept custom db and table names", async () => {
    const { SqliteProvider } = await loadApi(async () => null);
    const provider = SqliteProvider({
      dbName: "custom.db",
      tableName: "my_table",
    });
    expect(provider.kind).toBe("sqlite");
    expect(provider.dbName).toBe("custom.db");
    expect(provider.tableName).toBe("my_table");
  });
});

// ---------------------------------------------------------------------------
// 3. Single config operations
// ---------------------------------------------------------------------------

describe("Single config operations", () => {
  it("create().run() should invoke plugin:configurate|create with correct payload", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const result = await config
      .create({ theme: "dark", count: 5 } as never)
      .run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|create");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.fileName).toBe("app.json");
    expect(payload.baseDir).toBe(8);
    expect((payload.provider as Record<string, unknown>).kind).toBe("json");
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
    expect((payload.data as Record<string, unknown>).count).toBe(5);
    expect(result.data).toEqual({ theme: "dark", count: 5 });
  });

  it("load().run() should invoke plugin:configurate|load and return LockedConfig", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load")
          return { theme: "light", count: 10 };
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const locked = await config.load().run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(cmd).toBe("plugin:configurate|load");
    expect(locked.data).toEqual({ theme: "light", count: 10 });
  });

  it("save().run() should invoke plugin:configurate|save", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|save") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config.save({ theme: "dark" } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|save");
    const payload = args.payload as Record<string, unknown>;
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
  });

  it("delete() should invoke plugin:configurate|delete", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|delete") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config.delete();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|delete");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.fileName).toBe("app.json");
  });

  it("exists() should invoke plugin:configurate|exists and return boolean", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|exists") return true;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const result = await config.exists();
    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(cmd).toBe("plugin:configurate|exists");
  });

  it("exportAs should serialize unlocked data when keyring opts are provided", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command, args) => {
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
          expect(
            ((payload.source || {}).data as Record<string, unknown>).token,
          ).toBe("secret");
          return "theme: dark\ntoken: secret\n";
        }
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      token: keyring(String, { id: "tok" }),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command, args) => {
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
      });

    const schema = defineConfig({
      theme: String,
      token: keyring(String, { id: "tok" }),
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config.importFrom('theme = "dark"\ntoken = "secret"\n', "toml", {
      service: "svc",
      account: "acc",
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Patch operation
// ---------------------------------------------------------------------------

describe("Patch operation", () => {
  it("patch().run() should invoke plugin:configurate|patch with partial data", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const patched = await config.patch({ theme: "dark" } as never).run();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(patched.data).toEqual({ theme: "dark" });

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect((payload.data as Record<string, unknown>).theme).toBe("dark");
    // count should not be present since it was not patched
    expect((payload.data as Record<string, unknown>).count).toBeUndefined();
  });

  it("patch().unlock() should invoke plugin:configurate|patch with withUnlock=true", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|patch")
          return { theme: "dark", count: 5 };
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config.patch({ theme: "dark" } as never).unlock({
      service: "svc",
      account: "acc",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.withUnlock).toBe(true);
    expect(unlocked.data).toEqual({ theme: "dark", count: 5 });
  });

  it("patch().run() should not require lock when payload has no keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      token: keyring(String, { id: "api-token" }),
      theme: String,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const patched = await config.patch({ theme: "dark" } as never).run();
    expect(patched.data).toEqual({ theme: "dark" });

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|patch");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringEntries).toBeUndefined();
    expect(payload.keyringOptions).toBeUndefined();
  });

  it("patch().run() should require lock when payload includes keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async () => null);

    const schema = defineConfig({
      token: keyring(String, { id: "api-token" }),
      theme: String,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await expect(
      config.patch({ token: "secret" } as never).run(),
    ).rejects.toThrow("patch payload contains keyring fields");
    expect(invokeMock).toHaveBeenCalledTimes(0);
  });

  it("patch() should validate only provided keys when validateOnWrite=true", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|patch") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String, count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: {
        validateOnWrite: true,
      },
    });

    await config.patch({ theme: "dark" } as never).run();
    await expect(
      config.patch({ count: "invalid" } as never).run(),
    ).rejects.toThrow("Expected number");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Default values
// ---------------------------------------------------------------------------

describe("Default values", () => {
  it("should merge defaults into loaded data for missing keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: "dark" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" } as never,
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", lang: "en" });
  });

  it("should not overwrite existing keys with defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { theme: "dark", lang: "fr" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, lang: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { lang: "en" } as never,
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", lang: "fr" });
  });

  it("should deep merge nested defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { ui: { theme: "dark" } };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ ui: { theme: String, fontSize: Number } });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: null };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          return { __configurate_version__: 0, theme: "dark" };
        }
        if (command === "plugin:configurate|save") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String, newField: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    expect(
      (locked.data as Record<string, unknown>).__configurate_version__,
    ).toBe(1);
  });

  it("should not apply migration when data version matches current", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          return { __configurate_version__: 2, theme: "dark" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    expect(
      (locked.data as Record<string, unknown>).shouldNotBeApplied,
    ).toBeUndefined();
  });

  it("should apply multiple migrations in order", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          return { __configurate_version__: 0, value: "a" };
        }
        if (command === "plugin:configurate|save") {
          return null;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ value: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    expect(
      (locked.data as Record<string, unknown>).__configurate_version__,
    ).toBe(3);
  });

  it("should fail when a required migration step is missing", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          return { __configurate_version__: 0, value: "a" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ value: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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

    await expect(config.load().run()).rejects.toThrow(
      "missing migration step for version 0",
    );
  });

  it("should stamp version on create when versioning is enabled", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      version: 3,
    });

    await config.create({ theme: "dark" } as never).run();
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const payload = args.payload as Record<string, unknown>;
    expect(
      (payload.data as Record<string, unknown>).__configurate_version__,
    ).toBe(3);
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

    listenMock = mock((_event: string, _handler: unknown) =>
      Promise.resolve(unlistenFn),
    );
    mock.module("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));

    const mod = await import(
      `./index.ts?test=onchange-${Date.now()}-${Math.random()}`
    );
    const { Configurate, JsonProvider, defineConfig } = mod;

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "settings.json",
      baseDir: 8 as never,
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
      | ((event: {
          payload: { fileName: string; operation: string; targetId: string };
        }) => void)
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

    const mod = await import(
      `./index.ts?test=onchange-filter-${Date.now()}-${Math.random()}`
    );
    const { Configurate, JsonProvider, defineConfig } = mod;

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "settings.json",
      baseDir: 8 as never,
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
        targetId: "8|json|settings.json|nested|||",
      },
    });
    expect(callback).toHaveBeenCalledTimes(0);

    // Simulate event for the correct file
    handler({
      payload: {
        fileName: "settings.json",
        operation: "save",
        targetId: "8|json|settings.json||||",
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { theme: "dark", extra: true };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Key is not declared in schema",
    );
  });

  it("should allow unknown keys when allowUnknownKeys is true", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { theme: "dark", extra: true };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true, allowUnknownKeys: true },
    });

    const locked = await config.load().run();
    expect(locked.data).toEqual({ theme: "dark", extra: true });
  });

  it("should reject missing required keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return {};
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow("Missing required key");
  });

  it("should reject wrong type (expected string, got number)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { theme: 123 };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Expected string, got number",
    );
  });

  it("should reject wrong type (expected number, got string)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { count: "not-a-number" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ count: Number });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Expected number, got string",
    );
  });

  it("should reject wrong type (expected boolean, got string)", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") return { enabled: "yes" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ enabled: Boolean });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Expected boolean, got string",
    );
  });

  it("should validate array elements on read", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { tags: ["a", "b", 3] };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ tags: [String] });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Expected string, got number",
    );
  });

  it("should reject non-object where object is expected", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load")
          return { ui: "not-an-object" };
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({ ui: { theme: String } });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      validation: { validateOnRead: true },
    });

    await expect(config.load().run()).rejects.toThrow(
      "Expected object, got string",
    );
  });

  it("should pass validation when data matches schema", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async (command) => {
        if (command === "plugin:configurate|load") {
          return { name: "test", count: 42, enabled: true };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );

    const schema = defineConfig({
      name: String,
      count: Number,
      enabled: Boolean,
    });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "sub/file.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("cannot contain path separators");
  });

  it("should reject fileName with backslash", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "sub\\file.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
        }),
    ).toThrow("cannot contain path separators");
  });

  it('should reject fileName "."', async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: ".",
          baseDir: 8 as never,
          provider: JsonProvider(),
        }),
    ).toThrow('must not be "." or ".."');
  });

  it('should reject fileName ".."', async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "..",
          baseDir: 8 as never,
          provider: JsonProvider(),
        }),
    ).toThrow('must not be "." or ".."');
  });

  it("should reject dirName with empty segments", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
          options: { dirName: "a//b" },
        }),
    ).toThrow("must not contain empty or special segments");
  });

  it("should reject dirName with '.' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
          options: { dirName: "a/./b" },
        }),
    ).toThrow("must not contain empty or special segments");
  });

  it("should reject dirName with '..' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
          options: { dirName: "a/../b" },
        }),
    ).toThrow("must not contain empty or special segments");
  });

  it("should reject currentPath with '..' segment", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({ theme: String });
    expect(
      () =>
        new Configurate({
          schema,
          fileName: "app.json",
          baseDir: 8 as never,
          provider: JsonProvider(),
          options: { currentPath: "a/../b" },
        }),
    ).toThrow("must not contain empty or special segments");
  });

  it("should accept valid dirName and currentPath", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") return { theme: "dark" };
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({ theme: String });
    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      options: { dirName: "my-app/configs", currentPath: "v2/settings" },
    });

    await config.load().run();
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
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
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") {
          throw new Error("not found");
        }
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      apiKey: keyring(String, { id: "api-key" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config
      .create({ theme: "dark", apiKey: "secret-123" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    const [cmd, args] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load")
          return { theme: "dark", apiKey: null };
        if (command === "plugin:configurate|unlock")
          return { theme: "dark", apiKey: "decrypted" };
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      theme: String,
      apiKey: keyring(String, { id: "api-key" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config
      .load()
      .unlock({ service: "svc", account: "acc" });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // First call: load
    const [loadCmd] = invokeMock.mock.calls[0] as [string, unknown];
    expect(loadCmd).toBe("plugin:configurate|load");

    // Second call: unlock
    const [unlockCmd, unlockArgs] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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
    const { Configurate, JsonProvider, defineConfig, keyring } = await loadApi(
      async () => null,
    );

    const schema = defineConfig({
      token: keyring(String, { id: "tok" }),
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await expect(
      config.create({ token: "secret" } as never).run(),
    ).rejects.toThrow("keyring fields");
  });

  it("should handle nested keyring fields", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      });

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
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config
      .create({
        auth: { token: "t1", refreshToken: "r1" },
        name: "test",
      } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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
    const {
      Configurate,
      JsonProvider,
      defineConfig,
      keyring,
      optional,
      invokeMock,
    } = await loadApi(async (command) => {
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
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    const unlocked = await config
      .load()
      .unlock({ service: "svc", account: "acc" });
    expect(unlocked.data).toEqual({});
    expect(invokeMock).toHaveBeenCalledTimes(2);

    const [, unlockArgs] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    const unlockPayload = unlockArgs.payload as Record<string, unknown>;
    const entries = unlockPayload.keyringEntries as Array<{
      isOptional?: boolean;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isOptional).toBe(true);
  });

  it("should handle keyring in array schema (write entries)", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|load") return {};
        if (command === "plugin:configurate|create") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      tokens: [keyring(String, { id: "tok" })],
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config
      .create({ tokens: ["secret1", "secret2"] } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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
    const {
      Configurate,
      JsonProvider,
      defineConfig,
      keyring,
      optional,
      invokeMock,
    } = await loadApi(async (command) => {
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
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config
      .save({ theme: "dark" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("plugin:configurate|save");
    const payload = args.payload as Record<string, unknown>;
    expect(payload.keyringDeleteIds).toEqual(["tok"]);
    const opts = payload.keyringOptions as Record<string, unknown>;
    expect(opts.service).toBe("svc");
    expect(opts.account).toBe("acc");
  });

  it("reset should request stale optional keyring deletion on full replacement", async () => {
    const {
      Configurate,
      JsonProvider,
      defineConfig,
      keyring,
      optional,
      invokeMock,
    } = await loadApi(async (command) => {
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
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config
      .reset({ theme: "dark" } as never)
      .lock({ service: "svc", account: "acc" })
      .run();

    const [cmd, args] = invokeMock.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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
    expect(() => keyring(String, { id: "a/b" })).toThrow(
      "must not contain '/'",
    );
  });

  it("delete with keyring opts should include keyring entries", async () => {
    const { Configurate, JsonProvider, defineConfig, keyring, invokeMock } =
      await loadApi(async (command) => {
        if (command === "plugin:configurate|delete") return null;
        throw new Error(`unexpected command: ${command}`);
      });

    const schema = defineConfig({
      token: keyring(String, { id: "tok" }),
      name: String,
    });

    const config = new Configurate({
      schema,
      fileName: "app.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
    });

    await config.delete({ service: "svc", account: "acc" });

    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
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
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async () => ({
        value: "hello",
        __configurate_version__: 2,
      }));
    const schema = defineConfig({ value: String });
    const ran: number[] = [];
    const config = new Configurate({
      schema,
      fileName: "mig.json",
      baseDir: 8 as never,
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
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => ({ value: "a", __configurate_version__: 1 }),
    );
    const schema = defineConfig({ value: String });
    const ran: number[] = [];
    const config = new Configurate({
      schema,
      fileName: "mig2.json",
      baseDir: 8 as never,
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
    expect(
      (locked.data as Record<string, unknown>).__configurate_version__,
    ).toBe(3);
  });

  it("version is stamped into write payload", async () => {
    const { Configurate, JsonProvider, defineConfig, invokeMock } =
      await loadApi(async () => null);
    const schema = defineConfig({ label: String });
    const config = new Configurate({
      schema,
      fileName: "stamp.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      version: 5,
    });
    await config.save({ label: "hi" }).run();
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const data = (args.payload as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.__configurate_version__).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Default values edge cases
// ---------------------------------------------------------------------------

describe("Default values edge cases", () => {
  it("does not overwrite existing non-null values", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => ({ count: 7, label: "existing" }),
    );
    const schema = defineConfig({ count: Number, label: String });
    const config = new Configurate({
      schema,
      fileName: "def.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { count: 0, label: "default" },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).count).toBe(7);
    expect((locked.data as Record<string, unknown>).label).toBe("existing");
  });

  it("fills in missing top-level keys from defaults", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => ({ count: 3 }),
    );
    const schema = defineConfig({ count: Number, label: String });
    const config = new Configurate({
      schema,
      fileName: "def2.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { count: 0, label: "fallback" },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).label).toBe("fallback");
    expect((locked.data as Record<string, unknown>).count).toBe(3);
  });

  it("replaces null with default value", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => ({ count: null }),
    );
    const schema = defineConfig({ count: Number });
    const config = new Configurate({
      schema,
      fileName: "def3.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { count: 42 },
    });
    const locked = await config.load().run();
    expect((locked.data as Record<string, unknown>).count).toBe(42);
  });

  it("deep-merges nested defaults without overwriting existing sub-keys", async () => {
    const { Configurate, JsonProvider, defineConfig } = await loadApi(
      async () => ({ ui: { theme: "dark" } }),
    );
    const schema = defineConfig({ ui: { theme: String, fontSize: Number } });
    const config = new Configurate({
      schema,
      fileName: "def4.json",
      baseDir: 8 as never,
      provider: JsonProvider(),
      defaults: { ui: { theme: "light", fontSize: 14 } } as never,
    });
    const locked = await config.load().run();
    const ui = (locked.data as Record<string, unknown>).ui as Record<
      string,
      unknown
    >;
    expect(ui.theme).toBe("dark"); // existing value preserved
    expect(ui.fontSize).toBe(14); // missing key filled from defaults
  });
});
