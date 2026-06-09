#!/usr/bin/env bun
// slack-scout — standalone, read-only Slack surface (prx-hkm). A single
// Bun-compiled binary; the same composition root as `prx scout slack`.
//
// Run with the Slack USER token in the environment (SLACK_TOKEN), e.g.:
//   op run --env-file=slack.env -- slack-scout channels --limit 20
//   op run --env-file=slack.env -- slack-scout history --channel C0AV6H17Q79 --limit 30
//
// Read-only by construction; emits one JSON envelope (or, with --provenance, an
// SLSA statement). --ledger PATH also records the slack.read/v1 derivation.
//
// Build: bun build --compile packages/prx/src/slack/bin.ts --outfile dist/slack-scout

import { parseArgs } from "node:util";

import { SLACK_READ_OPS, SlackReadError, type SlackReadOp } from "@bounded-systems/slack";

import { execSlackScoutRead } from "./scout-cli.ts";

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function usage(): never {
  fail(
    `usage: slack-scout <${SLACK_READ_OPS.join("|")}> ` +
      "[--channel <id>] [--ts <ts>] [--limit <n>] [--cursor <c>] [--types <t>] " +
      "[--provenance] [--ledger <path>]",
    64,
  );
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      channel: { type: "string" },
      ts: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      types: { type: "string" },
      provenance: { type: "boolean", default: false },
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
} catch (err) {
  fail(`slack-scout: ${(err as Error).message}`, 64);
}

const { values, positionals } = parsed;
const op = positionals[0];
if (typeof op !== "string" || !(SLACK_READ_OPS as readonly string[]).includes(op)) {
  usage();
}
if ((op === "history" || op === "thread") && values.channel === undefined) {
  fail(`slack-scout ${op} requires --channel <id>`, 64);
}
if (op === "thread" && values.ts === undefined) {
  fail("slack-scout thread requires --ts <message-ts>", 64);
}
let limit: number | undefined;
if (values.limit !== undefined) {
  const n = Number.parseInt(values.limit, 10);
  if (!Number.isFinite(n) || n <= 0) fail("--limit must be a positive integer", 64);
  limit = n;
}

try {
  const json = await execSlackScoutRead({
    op: op as SlackReadOp,
    channel: values.channel,
    ts: values.ts,
    limit,
    cursor: values.cursor,
    types: values.types,
    provenance: values.provenance === true,
    ledger: values.ledger,
  });
  console.log(json);
  process.exit(0);
} catch (err) {
  if (err instanceof SlackReadError) {
    fail(`slack-scout ${err.code}: ${err.message}`, err.code === "MISSING_PARAM" ? 64 : 65);
  }
  fail(err instanceof Error ? err.message : String(err), 70);
}
