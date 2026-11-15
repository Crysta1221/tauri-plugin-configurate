import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";

const pkg = JSON.parse(readFileSync(join(cwd(), "package.json"), "utf8"));

const rootExport = pkg.exports["."];

// TypeScript 7 has no JS API for a Rollup plugin to call, so `tsc` compiles first (JS into .build, declarations
// into dist-js) and Rollup only bundles the emitted modules.
export default {
  input: {
    index: ".build/index.js",
    provider: ".build/provider.js",
  },
  output: [
    {
      dir: dirname(rootExport.import),
      format: "esm",
      entryFileNames: "[name].js",
    },
    {
      dir: dirname(rootExport.require),
      format: "cjs",
      entryFileNames: "[name].cjs",
      exports: "named",
    },
  ],
  external: [
    /^@tauri-apps\/api/,
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ],
};
