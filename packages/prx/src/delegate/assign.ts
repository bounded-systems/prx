/**
 * `prx delegate assign` — assignment verb (GH-1874, GH-1012).
 *
 * Sibling of `prx delegate next` (the picker — GH-983): `next` surfaces the
 * top portfolio candidate, `assign` puts an owner on the hook.
 *
 * GH-1012: the bd write plane has been removed. GitHub
 * is the write plane and Front Desk the read plane; there is no longer a
 * synchronous bd assignment write (nor a bd `show` eligibility read) from this
 * verb. It still validates the request — mode gating, `--self` login
 * resolution, agent trimming — and reports the intended assignment, but
 * performs no mutation. The eventual `gh issue edit` write is out of scope
 * here (see the GH-1012 migration plan).
 *
 * Modes — exactly one must be supplied:
 *   - `agent` set    → assign the named operator (caller-supplied; expected
 *     to be a GH login).
 *   - `self: true`   → resolve via `gh api user --jq .login` through
 *     `src/identity/self.ts` (GH-2012). No env or git fallback.
 *   - `unassign: true` → clear the assignee.
 */

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
  resolveSelfOperator?: (
    deps?: ResolveSelfOperatorDeps,
  ) => ReturnType<typeof defaultResolveSelfOperator>;
};

export type DelegateAssignResult = {
  exitCode: number;
  message: string;
};

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

  // GH-1012: the bd assignment write plane is gone; no mutation is performed
  // here. Owner resolution/validation above still runs so callers get the same
  // usage/resolution errors, but the write itself is a no-op pending the
  // GitHub (`gh issue edit`) path.
  const message =
    target.length === 0 ? `unassigned ${input.id}` : `delegated ${input.id} → ${target}`;
  return { exitCode: 0, message };
}
