#!/usr/bin/env node
// Copy non-TS assets (ci.yml template) from src/ to dist/ after tsc runs.
// tsc emits only compiled JS/dts; it does not copy sibling YAML files.
// The setup flow resolves the template relative to its own module, so the
// asset must travel with the compiled code.

import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const assets = [
  {
    from: resolve(repoRoot, "src", "core", "templates", "ci.yml"),
    to: resolve(repoRoot, "dist", "core", "templates", "ci.yml"),
  },
];

for (const asset of assets) {
  await mkdir(dirname(asset.to), { recursive: true });
  await cp(asset.from, asset.to);
  process.stdout.write(`copied ${asset.from} -> ${asset.to}\n`);
}
