#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so no build step is needed.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const r = spawnSync(process.execPath, [tsx, main, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 3);
