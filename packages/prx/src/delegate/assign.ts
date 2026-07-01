/**
 * `prx delegate assign` — bd-canonical assignment verb (GH-1874).
 *
 * Sibling of `prx delegate next` (the picker — GH-983): `next` surfaces the
 * top portfolio candidate, `assign` puts an owner on the hook. The verb is
 * bd-canonical: it writes only bd (`bd assign <id> <name>` — shorthand for
 * `bd update <id> --assignee <name>`); the bd→GH mirror's `push()` picks
 * up the assignee field on the next sync cadence (synchronous mirror
 * projection is out of scope — see plan §3a). No direct `gh issue edit`.
 *
 * Modes — exactly one must be supplied:
 *   - `agent` set    → assign the named operator (caller-supplied; expected
 *     to be a GH login — `prx delegate repair-assignees` rewrites legacy
 *     display-name strings to logins).
 *   - `self: true`   → resolve via `gh api user --jq .login` through
 *     `src/identity/self.ts` (GH-2012). No env or git fallback.
 *   - `unassign: true` → clear the bd assignee (`bd assign <id> ""`).
 */

import { runBdShow as defaultRunBdShow } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import {
  resolveSelfOperator as defaultResolveSelfOperator,
  type ResolveSelfOperatorDeps,
} from "../identity/self.ts";

export type DelegateAssignInput = {
  id: string;
  agent?: string | undefined;
  self?: boolean | undefined;
  unassign?: boolean | undefined;
  repoPath: string;
};

export type DelegateAssignDeps = {
  /**
   * GH-296 / prx-82b — sync runner for the daemon-routed assign write
   * (`prx beads update <id> --assignee <name>`), so assignment mutates the one
   * beads the daemon owns instead of host `bd`. Default: procRunner.
   */
  run?: CommandRunner;
  runBdShow?: typeof defaultRunBdShow;
  resolveSelfOperator?: (
    deps?: ResolveSelfOperatorDeps,
  ) => ReturnType<typeof defaultResolveSelfOperator>;
};

export type DelegateAssignResult = {
  exitCode: number;
  message: string;
};

// supply-plan-design-6nd: a GH-form id (`GH-1234`) that fails eligibility is
// often not a real bd/bd-show error but a structural mismatch — the repo has
// GitHub Issues disabled, or the id was copied from a GH-issue-keyed source
// (e.g. an external tracker) when the canonical id is the bd-native one
// (`<prefix>-<short>`, from `prx beads list`/`prx beads ready`). `assign`
// itself has no GH-specific parsing — any id string passes straight through
// to `bd show`/`bd update` — so this is purely a clearer failure message, not
// a behavior change for well-formed bd ids.
const GH_FORM_ID = /^GH-\d+$/i;

function ghFormHint(id: string): string {
  return GH_FORM_ID.test(id)
    ? ` (looks like a GitHub issue id — if this repo has GH Issues disabled, or ` +
        `its canonical tracker is bd, pass the bd-native id instead, e.g. from ` +
        `\`prx beads list\`/\`prx beads ready\`)`
    : "";
}

function modeCount(input: DelegateAssignInput): number {
  let n = 0;
  if (typeof input.agent === "string" && input.agent.length > 0) n++;
  if (input.self === true) n++;
  if (input.unassign === true) n++;
  return n;
}

export function runDelegateAssign(
  input: DelegateAssignInput,
  deps: DelegateAssignDeps = {},
): DelegateAssignResult {
  // Exactly-one-mode gate.
  const modes = modeCount(input);
  if (modes === 0) {
    return {
      exitCode: 2,
      message: "prx delegate assign: requires one of <agent>, --self, or --unassign",
    };
  }
  if (modes > 1) {
    return {
      exitCode: 2,
      message: "prx delegate assign: pick exactly one of <agent>, --self, or --unassign",
    };
  }

  // Eligibility: the bd record must exist and be open.
  const runBdShow = deps.runBdShow ?? defaultRunBdShow;
  const show = runBdShow(input.id, input.repoPath);
  if (!show.ok) {
    const detail = show.stderr.trim() || show.stdout.trim() || `bd show ${input.id} failed`;
    return {
      exitCode: 1,
      message: `prx delegate assign: not eligible — ${detail}${ghFormHint(input.id)}`,
    };
  }
  const status = show.record.status.toLowerCase();
  if (status === "closed") {
    return {
      exitCode: 1,
      message: `prx delegate assign: not eligible — ${input.id} is closed`,
    };
  }

  // Resolve the target agent (or the empty clear marker for --unassign).
  let target: string;
  if (input.unassign === true) {
    target = "";
  } else if (input.self === true) {
    const resolve = deps.resolveSelfOperator ?? defaultResolveSelfOperator;
    const resolved = resolve();
    if (!resolved.ok) {
      return { exitCode: 1, message: `prx delegate assign: ${resolved.message}` };
    }
    target = resolved.agent;
  } else {
    target = (input.agent ?? "").trim();
    if (target.length === 0) {
      return {
        exitCode: 2,
        message: "prx delegate assign: <agent> must be a non-empty operator name",
      };
    }
  }

  // GH-296 / prx-82b: write via the daemon. `bd assign <id> <name>` is shorthand
  // for `bd update <id> --assignee <name>` (empty string clears); route it as
  // `prx beads update <id> --assignee <name>` through the single writer.
  const run = deps.run ?? procRunner;
  const result = run(["prx", "beads", "update", input.id, "--assignee", target], {
    cwd: input.repoPath,
    check: false,
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "prx beads update failed";
    return {
      exitCode: result.status || 1,
      message: `prx delegate assign: ${detail}`,
    };
  }

  const message =
    target.length === 0 ? `unassigned ${input.id}` : `delegated ${input.id} → ${target}`;
  return { exitCode: 0, message };
}
