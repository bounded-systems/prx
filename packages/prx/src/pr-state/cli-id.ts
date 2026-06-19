import { basename } from "node:path";
import {
  loadIdentityConfig,
  defaultRunner,
  effectiveCanonicalIdPattern,
  type CommandRunner as GithubCommandRunner,
  type IdentityConfig,
} from "./github.ts";
import { adapterForCanonicalId } from "../adapters/domain-adapter.ts";
import { localRepoForCwd } from "./repos.ts";
import {
  buildCanonicalWorkUnitIdHelpers,
  type CanonicalWorkUnitIdHelpers,
} from "../machine/work_unit.ts";
import { CliError } from "./cli-error.ts";
import { detectBranchNameFromCwd } from "./cli-spawn.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules (the
// ADR's `cli-id.ts` Stage-0 leaf).
//
// Canonical work-unit-id resolution shared across the work / plan / session
// command families. The helpers are resolved lazily on first access (so
// `prx help` / non-repo commands don't pay a `git rev-parse`) and memoized for
// the CLI invocation in module state below; `resetCanonicalHelpers()` is called
// at the top of `runCli()` to clear it per invocation (tests share the process
// and chdir between cases).

let activeCanonicalHelpers: CanonicalWorkUnitIdHelpers | null = null;

let activeCanonicalIsDefault = true;

let activeIdentityConfig: IdentityConfig | null = null;

export function resetCanonicalHelpers(): void {
  activeCanonicalHelpers = null;
  activeCanonicalIsDefault = true;
  activeIdentityConfig = null;
}

export function ensureIdentityConfig(runner: GithubCommandRunner = defaultRunner): IdentityConfig {
  if (activeIdentityConfig) {
    return activeIdentityConfig;
  }
  activeIdentityConfig = loadIdentityConfig(process.cwd(), runner);
  return activeIdentityConfig;
}

export function ensureCanonicalHelpers(
  runner: GithubCommandRunner = defaultRunner,
): CanonicalWorkUnitIdHelpers {
  if (activeCanonicalHelpers) {
    return activeCanonicalHelpers;
  }
  const config = ensureIdentityConfig(runner);
  activeCanonicalHelpers = buildCanonicalWorkUnitIdHelpers(effectiveCanonicalIdPattern(config));
  activeCanonicalIsDefault = config.isDefault;
  return activeCanonicalHelpers;
}

export function canonicalFormatExample(): string {
  const helpers = ensureCanonicalHelpers();
  if (activeCanonicalIsDefault) {
    return "for example GH-456";
  }
  return `for example GH-456 or a canonical_id_pattern declared by a configured prx.toml [sources.<name>] (${helpers.pattern.source})`;
}

export function parseCanonicalWorkUnitId(value: string, flag: string): string {
  const helpers = ensureCanonicalHelpers();
  const normalized = helpers.normalize(value);
  if (helpers.isCanonical(normalized)) {
    return normalized;
  }
  // GH-2015: the static `combinedCanonicalIdPattern()` regex cannot encode
  // cwd-dependent surface ids (BD's bare-workspace arm reads
  // `bd_workspace_prefix` from `.prx/repos/index.json` via
  // `localWorkspacePrefix(cwd)`). Fall through to the adapter registry so
  // ids whose recognition is runtime-only still pass the gate. Gated on
  // `activeCanonicalIsDefault` — a per-repo `[identity] canonical_id_pattern`
  // overlay wins outright (operator explicitly pinned a shape).
  //
  // Try the trimmed verbatim form first so lowercase-only adapter arms
  // (BD's bare-workspace arm, BD long-id) preserve case for downstream bd
  // record lookup. Fall back to the uppercased form so case-stable arms
  // (`GH-\d+`, etc.) routed through a future adapter still match.
  if (activeCanonicalIsDefault) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && adapterForCanonicalId(trimmed) !== null) {
      return trimmed;
    }
    if (normalized !== trimmed && adapterForCanonicalId(normalized) !== null) {
      return normalized;
    }
  }
  // A `<prefix>-<rest>` id that survives to here is most often a *recognized*
  // bd surface id whose covering repo has no `bd_workspace_prefix` registered
  // (a pre-GH-1657 inventory row) — the bd bare-workspace adapter arm needs
  // that field to fire, so the id silently fails the gate. The generic
  // "must match CANONICAL-ID format (GH-456)" misleads in that case (it cost a
  // full debugging session to trace). Detect the bd-short shape and point at
  // the documented `prx repo backfill` / `prx repo refresh <slug>` remedy.
  const inputTrimmed = value.trim();
  if (activeCanonicalIsDefault && looksLikeBeadsShortId(inputTrimmed)) {
    const slug = localRepoForCwd(process.cwd())?.name;
    const refreshHint = slug ? ` (or \`prx repo refresh ${slug}\`)` : "";
    throw new CliError(
      `${flag} "${inputTrimmed}" looks like a beads id but is not recognized. ` +
        `This repo's bd workspace prefix is not registered in the repo inventory ` +
        `(a pre-GH-1657 row), so the bd id arm cannot resolve it. ` +
        `Run \`prx repo backfill\`${refreshHint} to populate bd_workspace_prefix, then retry. ` +
        `Otherwise the id must match CANONICAL-ID format (${canonicalFormatExample()}).`,
    );
  }
  throw new CliError(`${flag} must match CANONICAL-ID format (${canonicalFormatExample()})`);
}

function looksLikeBeadsShortId(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]*-[a-z0-9]+$/i.test(trimmed)) return false;
  const prefix = trimmed.slice(0, trimmed.indexOf("-")).toLowerCase();
  return prefix !== "gh" && prefix !== "notion" && prefix !== "bd";
}

export function detectWorkCommandTarget(cwd = process.cwd()): {
  workUnitId: string;
  launchFromCurrentWorkspace: boolean;
} {
  const helpers = ensureCanonicalHelpers();
  const cwdCandidate = helpers.normalize(basename(cwd));
  if (helpers.isCanonical(cwdCandidate)) {
    return { workUnitId: cwdCandidate, launchFromCurrentWorkspace: false };
  }

  const branchName = detectBranchNameFromCwd(cwd);
  const branchCandidate = branchName ? helpers.normalize(branchName) : "";
  if (helpers.isCanonical(branchCandidate)) {
    return { workUnitId: branchCandidate, launchFromCurrentWorkspace: false };
  }

  return {
    workUnitId: branchName ?? basename(cwd),
    launchFromCurrentWorkspace: true,
  };
}
