/**
 * Surface-sync action spec — the standalone contract.
 *
 * A discriminated union of reconciliation *intents*: what to do, described
 * env-agnostically (type + structured params + reason). No embedded shell
 * command — execution is a separate concern. A `commandForAction(intent, ctx)`
 * executor maps each intent to a command using execution context (repo path,
 * buffer path, worktree config). This is the "spec implemented by both":
 * surface-sync produces intents; the executor (today in github.ts) consumes
 * them. See docs/architecture/surface-sync-extraction.md (Stage 2b).
 */

export type SurfaceSyncAction =
  | {
      type: "delete_remote_branch";
      remote?: "origin" | "local";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "delete_local_branch";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "delete_worktree";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "create_local_branch";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "create_worktree";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "push_remote_branch";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      type: "open_pr";
      branch: string;
      ticket: string | null;
      reason: string;
    }
  | {
      // GH-1125: close a GH issue whose PR is already merged. Emitted when
      // `prx prune --merged-only` discovers an open issue + completed PR.
      // Branch is omitted because the action targets the issue, not a ref;
      // the issue number is the canonical identifier.
      type: "close_issue";
      issue: number;
      ticket: string | null;
      reason: string;
      // The merged PR ref that licenses the close (drives the close comment).
      pr: number | null;
    };
