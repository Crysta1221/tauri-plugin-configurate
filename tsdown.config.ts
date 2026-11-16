import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "guest-js/index.ts", provider: "guest-js/provider.ts" },
  format: ["esm", "cjs"],
  outDir: "dist-js",
  // tsconfig.json, not a build-only config that sets declarationDir / outDir: those make the tsgo fallback write
  // declarations to the wrong place. Declarations are emitted only for what the entries import, so test files stay out.
  tsconfig: "tsconfig.json",
  // The code is not browser-only (it also runs under Bun), and `browser` is ignored for the CJS output anyway.
  platform: "neutral",
  target: "es2022",
  // `@tauri-apps/api` is a peer dependency, so tsdown keeps it as an external import without further configuration.
  clean: true,
  sourcemap: false,
  minify: false,
  dts: {
    // Named so that a TypeScript upgrade cannot switch the generator unnoticed. TypeScript 7.0 makes it run the tsgo
    // CLI (deprecated in rolldown-plugin-dts, which warns on every build); 7.1 or later uses the tsgo API.
    generator: "tsgo",
  },
});
