/**
 * Board snapshot — the state contract between extract and (label, act).
 *
 * The shape a reader (today github's `boardStatus`, tomorrow a scout
 * extraction) produces and the surface-sync transform + the classifier
 * consume. Defined here so surface-sync owns its input contract; any richer
 * board-unit shape (github's `BoardUnit`) structurally satisfies it. This is
 * the "spec implemented by both" on the state side — see
 * docs/architecture/standalone-modules.md.
 *
 * The fields are exactly what the transform (`computeSurfaceSync`) and the
 * classifier (`classify`) read — no `OverviewRow`/`BoardColumn` cascade.
 */

export type BoardSnapshotUnit = {
  branch: string;
  ticket: string | null;
  status?:
    | {
        remote: {
          gh_issue: string;
          beads_issue: string;
          branch: string;
          buffer_branch?: string | undefined;
          pr: string;
          problem: string;
        };
        local: { branch: string; dir: string; problem: string };
      }
    | undefined;
  pr: { number: number | null };
  artifacts: { worktree: boolean; branch: boolean; pr: boolean };
  local: {
    staged: number | null;
    unstaged: number | null;
    untracked: number | null;
    conflicts: number | null;
  };
  remote_branch_author?: { isOperator: boolean | null } | undefined;
};

export type BoardSnapshot = {
  repo: string;
  units: BoardSnapshotUnit[];
};
