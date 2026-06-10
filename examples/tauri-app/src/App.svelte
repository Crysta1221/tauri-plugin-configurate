<script lang="ts">
  import {
    BaseDirectory,
    Configurate,
    defineConfig,
    keyring,
  } from 'tauri-plugin-configurate-api';
  import { BinaryProvider, JsonProvider } from 'tauri-plugin-configurate-api/provider';

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

  async function handleSeedAll() {
    try {
      await appConfig.create({ appName, port, theme }).run();
      await secretConfig.save({ apiKey }).lock(KEYRING_OPTS).run();
      addLog('seed all succeeded (json + binary)');
    } catch (e) {
      addLog(`seed all failed: ${e}`);
    }
  }

  async function handleLoadAll() {
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
        appName = data.appName;
        port = data.port;
        theme = data.theme;
        addLog(`app => name=${data.appName}, port=${data.port}, theme=${data.theme}`);
      } else if (appResult) {
        addLog(`app load failed: ${appResult.error.kind} ${appResult.error.message}`);
      }

      if (secretResult?.ok) {
        const data = secretResult.data as { apiKey: string };
        apiKey = data.apiKey;
        addLog(`secret => apiKey=${data.apiKey}`);
      } else if (secretResult) {
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

      addLog(
        `saveAll app=${appResult?.ok ? 'ok' : 'ng'} secret=${secretResult?.ok ? 'ok' : 'ng'}`,
      );
    } catch (e) {
      addLog(`saveAll failed: ${e}`);
    }
  }

  async function handleDeleteAll() {
    try {
      await appConfig.delete();
      await secretConfig.delete(KEYRING_OPTS);
      addLog('delete all succeeded');
    } catch (e) {
      addLog(`delete all failed: ${e}`);
    }
  }
</script>

<main class="container">
  <header class="header">
    <span class="eyebrow">tauri plugin</span>
    <h1>configurate</h1>
    <p class="summary">JSON · Binary(XChaCha20+keyring) のデモアプリ</p>
  </header>

  <div class="sections">
    <div class="section">
      <div class="section-head">
        <span class="dot"></span>
        <h2>JSON Config</h2>
        <code class="filename">app.json</code>
      </div>
      <div class="fields">
        <div class="field">
          <span class="label">appName</span>
          <input bind:value={appName} type="text" />
        </div>
        <div class="field">
          <span class="label">port</span>
          <input bind:value={port} type="number" />
        </div>
        <div class="field">
          <span class="label">theme</span>
          <input bind:value={theme} type="text" />
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span class="dot"></span>
        <h2>Binary Config</h2>
        <code class="filename">secret.bin</code>
        <span class="chip">XChaCha20</span>
      </div>
      <div class="fields">
        <div class="field">
          <span class="label">apiKey <span class="badge">keyring</span></span>
          <input bind:value={apiKey} type="password" />
        </div>
      </div>
    </div>

    <div class="section last">
      <div class="section-head">
        <span class="dot pulsed"></span>
        <h2>Batch Operations</h2>
      </div>
      <div class="fields">
        <div class="actions">
          <button onclick={handleSeedAll}>seed all</button>
          <button class="ghost" onclick={handleLoadAll}>loadAll().unlock()</button>
          <button class="ghost" onclick={handleSaveBatch}>saveAll().lock()</button>
          <button class="danger" onclick={handleDeleteAll}>delete all</button>
          <button class="ghost dim" onclick={() => (log = [])}>clear log</button>
        </div>
      </div>
    </div>
  </div>

  <div class="logbox">
    <div class="logbox-bar">
      <span class="dot" style="background: var(--c-green);"></span>
      <span class="logbox-title">Output</span>
      {#if log.length > 0}
        <span class="log-count">{log.length}</span>
      {/if}
    </div>
    <div class="logbox-body">
      {#each log as entry, i}
        <p class="entry" class:fresh={i === 0}>{entry}</p>
      {/each}
      {#if log.length === 0}
        <p class="log-empty">— no operations yet —</p>
      {/if}
    </div>
  </div>
</main>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=JetBrains+Mono:wght@400;500&display=swap');

  /* ── Design tokens ──────────────────────────────────── */
  :global(:root) {
    --c-base:      oklch(10.5% 0.01 65);
    --c-surface:   oklch(15%   0.012 65);
    --c-overlay:   oklch(19.5% 0.012 65);
    --c-border:    oklch(26%   0.01  65);
    --c-border2:   oklch(34%   0.01  65);
    --c-text:      oklch(93%   0.008 80);
    --c-muted:     oklch(57%   0.012 72);
    --c-subtle:    oklch(40%   0.008 72);
    --c-amber:     oklch(76%   0.155 72);
    --c-amber-dim: oklch(46%   0.10  72);
    --c-rose:      oklch(64%   0.185 18);
    --c-warn:      oklch(73%   0.14  55);
    --c-green:     oklch(68%   0.145 145);
  }

  :global(body) {
    margin: 0;
    padding: 0;
    background: var(--c-base);
    color: var(--c-text);
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.65;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .container {
    max-width: 820px;
    margin: 0 auto;
    padding: clamp(2rem, 5vw, 3.5rem) clamp(1rem, 4vw, 2rem) 4rem;
  }

  .header {
    margin-bottom: clamp(2rem, 4vw, 2.75rem);
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--c-border);
  }

  .eyebrow {
    display: inline-block;
    font-size: 0.67rem;
    font-weight: 500;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--c-amber);
    margin-bottom: 0.35rem;
  }

  h1 {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-size: clamp(1.8rem, 4vw, 2.5rem);
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1.08;
    color: var(--c-text);
    margin: 0 0 0.5rem;
  }

  .summary {
    margin: 0;
    font-size: 0.87rem;
    font-weight: 300;
    color: var(--c-muted);
  }

  .sections {
    margin-bottom: 2rem;
  }

  .section {
    padding: 1.4rem 0;
    border-bottom: 1px solid var(--c-border);
  }

  .section.last {
    border-bottom: none;
    padding-bottom: 0;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-bottom: 0.9rem;
  }

  .section-head h2 {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--c-muted);
    margin: 0;
  }

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--c-amber);
    flex-shrink: 0;
  }

  .dot.pulsed {
    animation: pulse 2.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.35; }
  }

  .filename {
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 0.71rem;
    color: var(--c-muted);
    background: var(--c-overlay);
    border: 1px solid var(--c-border);
    border-radius: 3px;
    padding: 0.07rem 0.38rem;
  }

  .chip {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--c-amber);
    background: oklch(46% 0.10 72 / 0.1);
    border: 1px solid oklch(46% 0.10 72 / 0.3);
    border-radius: 3px;
    padding: 0.06rem 0.32rem;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding-left: 1rem;
    border-left: 1px solid var(--c-border);
  }

  .field {
    display: grid;
    grid-template-columns: 148px 1fr;
    align-items: center;
    gap: 1rem;
  }

  .label {
    font-size: 0.81rem;
    color: var(--c-muted);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .badge {
    font-size: 0.59rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--c-amber);
    background: oklch(46% 0.10 72 / 0.1);
    border: 1px solid oklch(46% 0.10 72 / 0.38);
    border-radius: 3px;
    padding: 0.06rem 0.3rem;
    flex-shrink: 0;
  }

  input[type='text'],
  input[type='number'],
  input[type='password'] {
    width: 100%;
    padding: 0.45rem 0.68rem;
    background: var(--c-overlay);
    border: 1px solid var(--c-border);
    border-radius: 5px;
    color: var(--c-text);
    font-size: 0.85rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    appearance: none;
    -webkit-appearance: none;
  }

  input:focus {
    border-color: var(--c-amber-dim);
    box-shadow: 0 0 0 3px oklch(46% 0.10 72 / 0.18);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding-top: 0.2rem;
  }

  button {
    padding: 0.4rem 0.85rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--c-amber);
    background: var(--c-amber);
    color: oklch(11% 0.01 65);
    line-height: 1.45;
    transition: opacity 0.12s ease;
  }

  button:hover { opacity: 0.82; }
  button:active { opacity: 0.68; }

  button.danger {
    background: transparent;
    color: var(--c-rose);
    border-color: oklch(55% 0.17 18 / 0.45);
  }
  button.danger:hover {
    opacity: 1;
    background: oklch(55% 0.17 18 / 0.1);
  }

  button.ghost {
    background: transparent;
    color: var(--c-muted);
    border-color: var(--c-border);
  }
  button.ghost:hover {
    opacity: 1;
    color: var(--c-text);
    border-color: var(--c-border2);
  }

  button.ghost.dim {
    color: var(--c-subtle);
    border-color: oklch(22% 0.008 65);
  }
  button.ghost.dim:hover {
    color: var(--c-muted);
    border-color: var(--c-border);
  }

  .logbox {
    border: 1px solid var(--c-border);
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 290px;
  }

  .logbox-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.48rem 0.85rem;
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }

  .logbox-title {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--c-muted);
  }

  .log-count {
    margin-left: auto;
    font-size: 0.67rem;
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    color: var(--c-subtle);
    background: var(--c-overlay);
    border: 1px solid var(--c-border);
    border-radius: 3px;
    padding: 0.04rem 0.3rem;
  }

  .logbox-body {
    overflow-y: auto;
    flex: 1;
    background: oklch(12% 0.01 65);
  }

  .entry {
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 0.76rem;
    padding: 0.26rem 0.85rem;
    line-height: 1.55;
    word-break: break-all;
    color: var(--c-subtle);
    border-bottom: 1px solid oklch(17% 0.01 65);
    margin: 0;
  }

  .entry:last-child { border-bottom: none; }

  .entry.fresh {
    color: var(--c-text);
    background: oklch(15.5% 0.012 65);
  }

  .log-empty {
    padding: 1.2rem 0.85rem;
    margin: 0;
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
    font-size: 0.76rem;
    color: oklch(34% 0.008 65);
    font-style: italic;
  }

  @media (max-width: 560px) {
    .field {
      grid-template-columns: 1fr;
      gap: 0.3rem;
    }
    button { flex: 1; }
  }
</style>
