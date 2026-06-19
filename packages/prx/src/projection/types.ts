// Wire protocol between PRX (XState source of truth) and the Ink TUI
// (projection consumer). See GH-730.
//
// Invariants (enforced by the types themselves where possible):
//   1. `PrxProjection` is the only thing the UI sees. If a panel needs
//      data, it goes in the projection. No side-channel `exec`s from
//      the TUI.
//   2. `ValidAction.guard` is pre-computed upstream. UI renders disabled
//      state but never re-derives guards.
//   3. `SessionLayout.panes` is a fixed 2-tuple. Third pane = schema
//      change, not an ad-hoc `split-window`.

// GH-2098: the projection consumes the same branded `WorkUnitId` the rest of
// the system uses. Re-exported (not redefined) so a branch name, a git sha,
// and a work-unit id stay mutually non-assignable end to end. The old
// `GH-${number}` template literal was narrower than canonical and not
// brand-compatible.
import type { WorkUnitId } from "@bounded-systems/machine-schema";
export type { WorkUnitId };

export const projectionPhases = [
  "triaged",
  "in_progress",
  "pr_open",
  "waiting_on_ci",
  "waiting_on_review",
  "ready_to_merge",
  "merged",
  "closed",
] as const;

export type Phase = (typeof projectionPhases)[number];

export type PrInfo = {
  number: number;
  draft: boolean;
  url: string;
};

export type CiInfo = {
  state: "pending" | "success" | "failure";
  url: string;
};

export type WorktreeInfo = {
  path: string;
  detached: boolean;
};

export type WorkUnit = {
  id: WorkUnitId;
  title: string;
  phase: Phase;
  branch: string | null;
  pr: PrInfo | null;
  ci: CiInfo | null;
  worktree: WorktreeInfo | null;
};

export type TransitionCause = "user" | "gh_webhook" | "poll" | "hook";

export type TransitionEvent = {
  at: string;
  unit: WorkUnitId;
  from: Phase;
  to: Phase;
  cause: TransitionCause;
};

export type ValidActionGuard = "ok" | { blocked: string };

export type ValidAction = {
  event: string;
  label: string;
  command: string;
  guard: ValidActionGuard;
};

export type PhaseGroup = {
  phase: Phase;
  units: WorkUnitId[];
};

export type PrxProjection = {
  active: WorkUnit | null;
  timeline: TransitionEvent[];
  actions: ValidAction[];
  board: PhaseGroup[];
};

export type Dispatch = (action: ValidAction) => void;

export type PanelProps<S> = {
  slice: S;
  dispatch: Dispatch;
};

export type DashProps = {
  source: AsyncIterable<PrxProjection>;
};

export type SessionPaneKind = "dash" | "agent";

export type SessionPane = { kind: "dash"; cmd: "prx dash" } | { kind: "agent"; cmd: string };

export type SessionLayout = {
  sessionName: string;
  panes: [SessionPane & { kind: "dash" }, SessionPane & { kind: "agent" }];
  split: "horizontal" | "vertical";
};

export function isValidActionOk(action: ValidAction): boolean {
  return action.guard === "ok";
}

export function blockedReason(action: ValidAction): string | null {
  return action.guard === "ok" ? null : action.guard.blocked;
}
