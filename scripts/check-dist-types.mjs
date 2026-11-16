// Type-checks guest-js sources (via tsconfig.json) and scripts/consumer against the built dist-js declarations
// through both module systems and both resolution modes. Run `bun run build` first. Catches declarations that are
// valid on their own but wrong for consumers, such as a runtime export that ends up type-only.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
// The consumer must live inside the package so that its own name resolves through `exports`.
const dir = mkdtempSync(join(root, "scripts", ".consumer-"));

// `.mts` resolves the package through the `import` condition, `.cts` through `require`.
const cases = [
  { ext: "mts", flags: ["--module", "node16", "--moduleResolution", "node16"] },
  // @tauri-apps/api maps `types` to one ESM-typed .d.ts for both conditions, so any CommonJS consumer under node16
  // gets TS1479 inside our declarations. That is upstream's, so library checking is off for this one case; the
  // consumer file itself is still fully checked.
  { ext: "cts", flags: ["--module", "node16", "--moduleResolution", "node16", "--skipLibCheck"] },
  { ext: "mts", flags: ["--module", "esnext", "--moduleResolution", "bundler"] },
  { ext: "cts", flags: ["--module", "preserve", "--moduleResolution", "bundler"] },
];

let failed = false;
try {
  const srcRun = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "inherit",
  });
  if (srcRun.status !== 0) failed = true;
  process.stdout.write(`${srcRun.status === 0 ? "ok  " : "FAIL"} tsconfig.json\n`);

  for (const { ext, flags } of cases) {
    const file = join(dir, `consumer.${ext}`);
    copyFileSync(join(root, "scripts", "consumer", "consumer.ts"), file);
    const args = [
      tscBin,
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--target",
      "es2022",
      "--lib",
      "es2022",
      ...flags,
      file,
    ];
    const run = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    const label = `${ext} ${flags[1]} ${flags[3]}`;
    if (run.status !== 0) failed = true;
    process.stdout.write(`${run.status === 0 ? "ok  " : "FAIL"} ${label}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
