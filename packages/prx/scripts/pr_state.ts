#!/usr/bin/env bun
import { runCli } from "../src/pr-state/cli.ts";

const exitCode = await runCli(Bun.argv.slice(2), {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

process.exit(exitCode);
