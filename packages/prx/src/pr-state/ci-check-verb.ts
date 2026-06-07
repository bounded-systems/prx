// `prx remote-ci-check` (a.k.a. `repo ci` / `scout ci`) and `prx scout-logs`
// (`scout logs`) as spec-driven VerbSpecs — deps-bearing reads migrated off
// cli.ts (ADR docs/prx/cli-decomposition.md). Both resolve the PR ref (explicit
// `--pr` or the current branch), read the failing-check surface, and exit 1 when
// anything is failing — the canonical `exitCode` projection: a successful run
// whose output maps to a non-zero CLI exit (the legacy handlers returned 1).

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { formatRemoteCiCheck, formatScoutLogs } from "./cli-format.ts";
import {
  remoteCiCheck,
  resolveCurrentPrRef,
  scoutLogs,
  type RemoteCiCheckResult,
  type ScoutLogsResult,
} from "./github.ts";

export type RemoteCiCheckDeps = {
  resolveCurrentPrRef: typeof resolveCurrentPrRef;
  remoteCiCheck: typeof remoteCiCheck;
};
const realRemoteCiCheckDeps = (): RemoteCiCheckDeps => ({ resolveCurrentPrRef, remoteCiCheck });

export const RemoteCiCheckOutput = z
  .object({
    repoPath: z.string(),
    pr: z.string(),
    failingChecks: z.array(z.unknown()),
  })
  .loose();
export type RemoteCiCheckOutput = z.infer<typeof RemoteCiCheckOutput>;

export const remoteCiCheckVerb = defineVerb({
  id: "remote-ci-check",
  summary: "Report a PR's failing remote CI checks; exits 1 when any are failing.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    pr: z.string().optional().describe("PR ref (number/url/branch); defaults to the current branch"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: RemoteCiCheckOutput,
  deps: realRemoteCiCheckDeps,
  run: (input, deps: RemoteCiCheckDeps = realRemoteCiCheckDeps()): RemoteCiCheckOutput => {
    const prRef = input.pr ?? deps.resolveCurrentPrRef(input["repo-path"]);
    return deps.remoteCiCheck(input["repo-path"], prRef);
  },
  render: (out, input) => formatRemoteCiCheck(out as RemoteCiCheckResult, input.format),
  exitCode: (out) => (out.failingChecks.length > 0 ? 1 : 0),
});

export type ScoutLogsDeps = {
  resolveCurrentPrRef: typeof resolveCurrentPrRef;
  scoutLogs: typeof scoutLogs;
};
const realScoutLogsDeps = (): ScoutLogsDeps => ({ resolveCurrentPrRef, scoutLogs });

export const ScoutLogsOutput = z
  .object({
    repoPath: z.string(),
    pr: z.string(),
    checks: z.array(z.unknown()),
  })
  .loose();
export type ScoutLogsOutput = z.infer<typeof ScoutLogsOutput>;

export const scoutLogsVerb = defineVerb({
  id: "scout-logs",
  summary: "Summarize a PR's failing-check logs; exits 1 when any checks are failing.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    pr: z.string().optional().describe("PR ref (number/url/branch); defaults to the current branch"),
    "max-lines": z.coerce.number().default(200).describe("max log lines per failing check"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: ScoutLogsOutput,
  deps: realScoutLogsDeps,
  run: (input, deps: ScoutLogsDeps = realScoutLogsDeps()): ScoutLogsOutput => {
    const prRef = input.pr ?? deps.resolveCurrentPrRef(input["repo-path"]);
    return deps.scoutLogs(input["repo-path"], prRef, undefined, input["max-lines"]);
  },
  render: (out, input) => formatScoutLogs(out as ScoutLogsResult, input.format),
  exitCode: (out) => (out.checks.length > 0 ? 1 : 0),
});
