import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import typescript from "@rollup/plugin-typescript";

const pkg = JSON.parse(readFileSync(join(cwd(), "package.json"), "utf8"));

const rootExport = pkg.exports["."];

export default {
  input: {
    index: "guest-js/index.ts",
    provider: "guest-js/provider.ts",
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
  plugins: [
    typescript({
      declaration: true,
      declarationDir: dirname(rootExport.import),
    }),
  ],
  external: [
    /^@tauri-apps\/api/,
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ],
};
