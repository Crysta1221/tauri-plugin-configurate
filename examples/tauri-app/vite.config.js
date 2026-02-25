import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import process from "process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  resolve: {
    // Point 'tauri-plugin-configurate-api' directly at the TypeScript source.
    // This avoids the need to run `rollup -c` before every `tauri dev` session
    // and prevents stale pnpm / Vite pre-bundle cache issues that would
    // otherwise surface as "_keyringBrand is not defined" errors.
    alias: {
      "tauri-plugin-configurate-api": path.resolve(__dirname, "../../guest-js/index.ts"),
    },
    preserveSymlinks: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // prevent Vite from obscuring rust errors
  clearScreen: false,
  // tauri expects a fixed port, fail if that port is not available
  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
});
