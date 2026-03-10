<script lang="ts">
  import {
    BaseDirectory,
    BinaryProvider,
    Configurate,
    JsonProvider,
    defineConfig,
    keyring,
  } from 'tauri-plugin-configurate-api';

  const appSchema = defineConfig({
    appName: String,
    port: Number,
    theme: String,
  });

  const secretSchema = defineConfig({
    apiKey: keyring(String, { id: 'api-key' }),
  });

  const KEYRING_OPTS = { service: 'tauri-configurate-example', account: 'default' };

  const appConfig = new Configurate({
    schema: appSchema,
    fileName: 'app.json',
    baseDir: BaseDirectory.AppConfig,
    provider: JsonProvider(),
  });

  const secretConfig = new Configurate({
    schema: secretSchema,
    fileName: 'secret.bin',
    baseDir: BaseDirectory.AppConfig,
    provider: BinaryProvider({ encryptionKey: 'example-binary-key' }),
  });

  let log = $state<string[]>([]);
  let appName = $state('MyApp');
  let port = $state(3000);
  let theme = $state('dark');
  let apiKey = $state('my-api-key-123');

  function addLog(msg: string) {
    log = [`[${new Date().toLocaleTimeString()}] ${msg}`, ...log];
  }

  async function handleCreate() {
    try {
      await appConfig.create({ appName, port, theme }).run();
      await secretConfig.save({ apiKey }).lock(KEYRING_OPTS).run();
      addLog('create/save succeeded');
    } catch (e) {
      addLog(`create/save failed: ${e}`);
    }
  }

  async function handleLoad() {
    try {
      const loaded = await Configurate.loadAll([
        { id: 'app', config: appConfig },
        { id: 'secret', config: secretConfig },
      ])
        .unlock('secret', KEYRING_OPTS)
        .run();

      const appResult = loaded.results.app;
      const secretResult = loaded.results.secret;

      if (appResult?.ok) {
        const data = appResult.data as { appName: string; port: number; theme: string };
        addLog(`app => name=${data.appName}, port=${data.port}, theme=${data.theme}`);
      }
      if (secretResult?.ok) {
        const data = secretResult.data as { apiKey: string };
        addLog(`secret => apiKey=${data.apiKey}`);
      }
      if (!secretResult?.ok) {
        addLog(`secret load failed: ${secretResult.error.kind} ${secretResult.error.message}`);
      }
    } catch (e) {
      addLog(`loadAll failed: ${e}`);
    }
  }

  async function handleSaveBatch() {
    try {
      const result = await Configurate.saveAll([
        { id: 'app', config: appConfig, data: { appName, port, theme } },
        { id: 'secret', config: secretConfig, data: { apiKey } },
      ])
        .lock('secret', KEYRING_OPTS)
        .run();

      const appResult = result.results.app;
      const secretResult = result.results.secret;

      addLog(`saveAll app=${appResult?.ok ? 'ok' : 'ng'} secret=${secretResult?.ok ? 'ok' : 'ng'}`);
    } catch (e) {
      addLog(`saveAll failed: ${e}`);
    }
  }

  async function handleDelete() {
    try {
      await appConfig.delete();
      await secretConfig.delete(KEYRING_OPTS);
      addLog('delete succeeded');
    } catch (e) {
      addLog(`delete failed: ${e}`);
    }
  }
</script>

<main class="container">
  <h1>tauri-plugin-configurate demo (new API)</h1>

  <section class="inputs">
    <h2>Config values</h2>
    <label>appName <input bind:value={appName} type="text" /></label>
    <label>port <input bind:value={port} type="number" /></label>
    <label>theme <input bind:value={theme} type="text" /></label>
    <label class="secret">
      apiKey <span class="badge">keyring</span>
      <input bind:value={apiKey} type="password" />
    </label>
  </section>

  <section class="actions">
    <button onclick={handleCreate}>create/save</button>
    <button onclick={handleLoad}>loadAll().unlock()</button>
    <button onclick={handleSaveBatch}>saveAll().lock()</button>
    <button class="danger" onclick={handleDelete}>delete()</button>
    <button onclick={() => (log = [])}>Clear log</button>
  </section>

  <section class="logbox">
    <h2>Log</h2>
    {#each log as entry}
      <p class="entry">{entry}</p>
    {/each}
    {#if log.length === 0}
      <p class="empty">No operations yet.</p>
    {/if}
  </section>
</main>

<style>
  .container { max-width: 760px; margin: 2rem auto; font-family: system-ui, sans-serif; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; margin-bottom: 0.75rem; color: #555; }
  section { margin-bottom: 2rem; }
  .inputs { display: grid; gap: 0.6rem; }
  label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
  label input { flex: 1; padding: 0.3rem 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
  .badge { font-size: 0.75rem; background: #fef3c7; color: #92400e; border: 1px solid #fde68a; border-radius: 4px; padding: 0.1rem 0.4rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button { padding: 0.45rem 1rem; border: 1px solid #2563eb; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; font-size: 0.9rem; }
  button.danger { background: #ef4444; border-color: #dc2626; }
  button.danger:hover { opacity: 0.85; }
  button:last-child { background: #e5e7eb; color: #374151; border-color: #d1d5db; }
  button:hover { opacity: 0.85; }
  .logbox { background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 1rem; max-height: 320px; overflow-y: auto; }
  .entry { font-family: monospace; font-size: 0.8rem; margin: 0.25rem 0; word-break: break-all; }
  .empty { color: #9ca3af; font-size: 0.85rem; }
</style>
