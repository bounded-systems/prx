// `prx protect-main` (a.k.a. `repo protect-main`) as a spec-driven VerbSpec — a
// deps-bearing verb migrated off cli.ts (ADR docs/prx/cli-decomposition.md). It
// reconciles main-branch protection (branch-protection or ruleset backend) in
// one of two modes: `--check` reports drift (and exits 1 via the `exitCode`
// projection when protection doesn't match), otherwise it builds/applies the
// desired protection. The flag→requirement derivation (the `--strict` cascade +
// the deno-style `--allow` spec) lives in `run`, not the schema; `--allow` and
// `--require-status-check` are repeatable list flags (parseArgs accumulates).

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { CliError } from "./cli-error.ts";
import { formatProtectMain, formatProtectMainCheck } from "./cli-format.ts";
import {
  checkMainBranchProtection,
  protectMainBranch,
  type ProtectMainBackend,
  type ProtectMainBranchCheckResult,
  type ProtectMainBranchResult,
} from "./github.ts";

const protectMainAllowChoices = [
  "strict",
  "enforce-admins",
  "conversation-resolution",
  "last-push-approval",
  "linear-history",
] as const;

type ProtectMainAllowChoice = (typeof protectMainAllowChoices)[number];

function parseProtectMainAllow(value: string): { type: ProtectMainAllowChoice | "status-check"; value?: string } {
  const normalized = value.trim();
  if (protectMainAllowChoices.includes(normalized as ProtectMainAllowChoice)) {
    return { type: normalized as ProtectMainAllowChoice };
  }
  if (normalized.startsWith("status-check:")) {
    const checkName = normalized.slice("status-check:".length).trim();
    if (!checkName) {
      throw new CliError("--allow status-check:<name> requires a non-empty check name");
    }
    return { type: "status-check", value: checkName };
  }
  throw new CliError(
    `Invalid value for --allow: ${value}. Expected one of ${protectMainAllowChoices.join(", ")}, or status-check:<name>`,
  );
}

export type ProtectMainDeps = {
  checkMainBranchProtection: typeof checkMainBranchProtection;
  protectMainBranch: typeof protectMainBranch;
};
const realProtectMainDeps = (): ProtectMainDeps => ({ checkMainBranchProtection, protectMainBranch });

// `check` and `apply` return different rich result shapes; the projection keeps
// the discriminant + the opaque result (render/exitCode narrow on `kind`).
export const ProtectMainOutput = z
  .object({ kind: z.enum(["check", "apply"]), result: z.unknown() })
  .strict();
export type ProtectMainOutput = z.infer<typeof ProtectMainOutput>;

export const protectMainVerb = defineVerb({
  id: "protect-main",
  summary:
    "Reconcile main-branch protection (branch-protection or ruleset); `--check` reports drift and exits 1 when it doesn't match.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    ruleset: z.coerce.boolean().default(false).describe("use the ruleset backend (shorthand for --backend ruleset)"),
    backend: z.enum(["branch-protection", "ruleset"]).optional().describe("protection backend"),
    repo: z.string().optional().describe("owner/name override"),
    branch: z.string().default("main").describe("branch to protect"),
    apply: z.coerce.boolean().default(false).describe("apply the protection (default is dry-run)"),
    check: z.coerce.boolean().default(false).describe("report drift instead of applying; exits 1 on mismatch"),
    solo: z.coerce.boolean().default(false).describe("solo-maintainer mode (relax contributor-count requirements)"),
    allow: z.array(z.string()).default([]).describe("deno-style allowances (repeatable): strict | enforce-admins | conversation-resolution | last-push-approval | linear-history | status-check:<name>"),
    strict: z.coerce.boolean().default(false).describe("enable the full strict requirement set"),
    "enforce-admins": z.coerce.boolean().default(false).describe("include administrators in protection"),
    "require-conversation-resolution": z.coerce.boolean().default(false).describe("require conversation resolution before merge"),
    "require-last-push-approval": z.coerce.boolean().default(false).describe("require approval of the most recent push"),
    "require-linear-history": z.coerce.boolean().default(false).describe("require a linear history"),
    "require-status-check": z.array(z.string()).default([]).describe("required status-check context (repeatable)"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: ProtectMainOutput,
  deps: realProtectMainDeps,
  run: (input, deps: ProtectMainDeps = realProtectMainDeps()): ProtectMainOutput => {
    const backend: ProtectMainBackend = input.ruleset ? "ruleset" : (input.backend ?? "branch-protection");

    const allowEntries = input.allow.map(parseProtectMainAllow);
    const strictFromAllow = allowEntries.some((e) => e.type === "strict");
    const effectiveStrict = input.strict || strictFromAllow;
    const allowedStatusChecks = allowEntries
      .filter((e): e is { type: "status-check"; value: string } => e.type === "status-check")
      .map((e) => e.value);

    // A requirement is on when --strict is in effect, its own flag is set, or an
    // `--allow <name>` opted into it; otherwise undefined (leave unset).
    const req = (flag: boolean, allowType: ProtectMainAllowChoice): true | undefined =>
      effectiveStrict || flag || allowEntries.some((e) => e.type === allowType) ? true : undefined;

    const requiredStatusChecks = [...input["require-status-check"], ...allowedStatusChecks];
    const opts = {
      backend,
      repo: input.repo,
      branch: input.branch,
      solo: input.solo,
      enforceAdmins: req(input["enforce-admins"], "enforce-admins"),
      requireConversationResolution: req(input["require-conversation-resolution"], "conversation-resolution"),
      requireLastPushApproval: req(input["require-last-push-approval"], "last-push-approval"),
      requireLinearHistory: req(input["require-linear-history"], "linear-history"),
      requiredStatusChecks: requiredStatusChecks.length > 0 ? requiredStatusChecks : undefined,
    };

    if (input.check) {
      return { kind: "check", result: deps.checkMainBranchProtection(input["repo-path"], opts) };
    }
    // --check forces dry-run; otherwise honor --apply.
    return { kind: "apply", result: deps.protectMainBranch(input["repo-path"], { ...opts, apply: input.apply }) };
  },
  render: (out, input) =>
    out.kind === "check"
      ? formatProtectMainCheck(out.result as ProtectMainBranchCheckResult, input.format)
      : formatProtectMain(out.result as ProtectMainBranchResult, input.format),
  exitCode: (out) =>
    out.kind === "check" && !(out.result as ProtectMainBranchCheckResult).matches ? 1 : 0,
});
