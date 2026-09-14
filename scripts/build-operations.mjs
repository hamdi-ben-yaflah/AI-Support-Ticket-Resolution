import { rm } from "node:fs/promises";

import { build } from "esbuild";

await rm("build/operations", { recursive: true, force: true });

await build({
  bundle: true,
  conditions: ["react-server", "node", "require"],
  external: ["@huggingface/transformers"],
  entryNames: "[name]",
  entryPoints: ["scripts/container-migrate.ts", "scripts/ingest.ts"],
  format: "cjs",
  legalComments: "none",
  outExtension: { ".js": ".cjs" },
  outdir: "build/operations",
  platform: "node",
  sourcemap: false,
  target: "node24",
});
