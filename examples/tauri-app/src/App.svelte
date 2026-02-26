<script lang="ts">
  import {
    Configurate,
    defineConfig,
    keyring,
    BaseDirectory,
    ConfigurateFactory,
  } from 'tauri-plugin-configurate-api';
  // Schema definition – Single Source of Truth.
  // "database.password" and "apiKey" are keyring-protected fields.
  const schema = defineConfig({
    appName: String,
    port: Number,
    database: {
      host: String,
      password: keyring(String, { id: 'db-password' }),
    },
    apiKey: keyring(String, { id: 'api-key' }),
  });
  // Keyring options shared across all operations.
  const KEYRING_OPTS = { service: 'tauri-configurate-example', account: 'default' };
  const config = new Configurate(schema, {
    name: 'example-config',
    dir: BaseDirectory.AppConfig,
    format: 'json',
  });

  let log = $state<string[]>([]);
  let appName = $state('MyApp');
  let port = $state(3000);
  let dbHost = $state('localhost');
  let dbPassword = $state('secret-db-pass');
  let apiKey = $state('my-api-key-123');
  function addLog(msg: string) {
    log = [`[${new Date().toLocaleTimeString()}] ${msg}`, ...log];
  }
  // Create – writes plain fields to disk and secrets to the OS keyring (IPC x1).
  async function handleCreate() {
    try {
      await config
        .create({ appName, port, database: { host: dbHost, password: dbPassword }, apiKey })
        .lock(KEYRING_OPTS)
        .run();
      addLog('create() succeeded. Secrets stored in OS keyring.');
    } catch (e) {
      addLog(`create() failed: ${e}`);
    }
  }
  // Load locked – keyring fields are null (IPC x1).
  async function handleLoad() {
    try {
      const locked = await config.load().run();
      addLog(
        `load() appName="${locked.data.appName}" port=${locked.data.port} ` +
        `db.host="${locked.data.database.host}" ` +
        `db.password=${JSON.stringify(locked.data.database.password)} ` +
        `apiKey=${JSON.stringify(locked.data.apiKey)}`,
      );
    } catch (e) {
      addLog(`load() failed: ${e}`);
    }
  }
  // Load + unlock – fetches secrets from the OS keyring in the same IPC call (IPC x1).
  async function handleLoadUnlock() {
    try {
      const unlocked = await config.load().unlock(KEYRING_OPTS);
      addLog(
        `load().unlock() appName="${unlocked.data.appName}" port=${unlocked.data.port} ` +
        `db.host="${unlocked.data.database.host}" ` +
        `db.password="${unlocked.data.database.password}" ` +
        `apiKey="${unlocked.data.apiKey}"`,
      );
      unlocked.lock();
    } catch (e) {
      addLog(`load().unlock() failed: ${e}`);
    }
  }
  // Save – overwrites the file and updates keyring secrets (IPC x1).
  async function handleSave() {
    try {
      await config
        .save({ appName, port, database: { host: dbHost, password: dbPassword }, apiKey })
        .lock(KEYRING_OPTS)
        .run();
      addLog('save() succeeded. Config and keyring entries overwritten.');
    } catch (e) {
      addLog(`save() failed: ${e}`);
    }
  }
  // Delete – removes the config file from disk and wipes keyring secrets (IPC x1).
  async function handleDelete() {
    try {
      await config.delete(KEYRING_OPTS);
      addLog('delete() succeeded. Config file and keyring entries removed.');
    } catch (e) {
      addLog(`delete() failed: ${e}`);
    }
  }
</script>
<main class="container">
  <h1>tauri-plugin-configurate demo</h1>
  <section class="inputs">
    <h2>Config values</h2>
    <label>appName <input bind:value={appName} type="text" /></label>
    <label>port <input bind:value={port} type="number" /></label>
    <label>database.host <input bind:value={dbHost} type="text" /></label>
    <label class="secret">
      database.password <span class="badge">keyring</span>
      <input bind:value={dbPassword} type="password" />
    </label>
    <label class="secret">
      apiKey <span class="badge">keyring</span>
      <input bind:value={apiKey} type="password" />
    </label>
  </section>
  <section class="actions">
    <button onclick={handleCreate}>create()</button>
    <button onclick={handleLoad}>load() locked</button>
    <button onclick={handleLoadUnlock}>load().unlock()</button>
    <button onclick={handleSave}>save()</button>
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
  button { padding: 0.45rem 1rem; border: 1px solid #6366f1; border-radius: 6px; background: #6366f1; color: #fff; cursor: pointer; font-size: 0.9rem; }
  button.danger { background: #ef4444; border-color: #dc2626; }
  button.danger:hover { opacity: 0.85; }
  button:last-child { background: #e5e7eb; color: #374151; border-color: #d1d5db; }
  button:hover { opacity: 0.85; }
  .logbox { background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 1rem; max-height: 320px; overflow-y: auto; }
  .entry { font-family: monospace; font-size: 0.8rem; margin: 0.25rem 0; word-break: break-all; }
  .empty { color: #9ca3af; font-size: 0.85rem; }
</style>
