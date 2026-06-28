#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import { applyBrokeredGhToken } from "../src/github-app/apply.ts";
import { runCli } from "../src/pr-state/cli.ts";

// If a GitHub App is configured, mint an installation token and publish it as
// GH_TOKEN before any verb runs (headless auth; fail-open to personal `gh`).
// The node:fs PEM read lives here at the script edge so src/ stays fs-free.
try {
  await applyBrokeredGhToken({ readFile: (path) => readFileSync(path, "utf8") });
} catch (e) {
  console.error(`prx: GitHub App token broker failed: ${(e as Error).message}`);
  process.exit(1);
}

const exitCode = await runCli(Bun.argv.slice(2), {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

process.exit(exitCode);
