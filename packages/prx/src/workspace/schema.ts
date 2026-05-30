/**
 * Workspace actor contract (GH-1978).
 *
 * Zod input/output schemas for the six accepts of the `workspace`
 * actor: reserve, materialize, prepare, sync, service, teardown. Every
 * driver (worktrunk today; devcontainer / nix devShell / CI pre-job
 * tomorrow) shares this contract. The contract MUST NOT leak driver
 * vocabulary: no "worktrunk", no "post-start", no hook names. If a
 * driver adds a field here, it has stopped being a driver.
 *
 * Lifecycle states are reserved → materialized → prepared → ready ⇄
 * running → torn_down. `workspace_id` is a 12-hex stable identifier for
 * a worktree-on-disk (sha256({host_repo_slug, branch}) truncated — the
 * worktree path is deliberately *not* in the hash so the id is stable
 * across the pre-/post-materialize cwd boundary; see
 * `computeWorkspaceId`). The actor computes it; drivers must not supply
 * it.
 */

import { z } from "zod";

export const Lifecycle = z.enum(["materialized", "attached", "running"]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const WorkspaceId = z.string().regex(/^[a-f0-9]{12}$/);
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const ReserveInput = z.object({
  branch: z.string().min(1),
  base: z.string().default("origin/main"),
  /**
   * Create the branch ref locally only — do not push it to the remote.
   * Set by ephemeral session-open (intake/triage), whose branches must
   * never reach GitHub origin (ai-home-rkg1w.1 §3.5 / GH-2271). The
   * worktrunk pre-switch hook leaves this `false` and keeps publishing
   * the remote branch ref.
   */
  local_only: z.boolean().default(false),
});
export type ReserveInput = z.infer<typeof ReserveInput>;

export const MaterializeInput = z.object({
  workspace_id: WorkspaceId,
});
export type MaterializeInput = z.infer<typeof MaterializeInput>;

export const MaterializeOutput = z.object({
  workspace_id: WorkspaceId,
  worktree_path: z.string(),
  branch: z.string(),
  status: z.enum(["created", "exists", "error"]),
  error: z.string().optional(),
});
export type MaterializeOutput = z.infer<typeof MaterializeOutput>;

export const ReserveOutput = z.object({
  workspace_id: WorkspaceId,
  branch_ref: z.string(),
  status: z.enum([
    "created",
    "exists-local",
    "exists-remote",
    "skipped",
    "base-unresolved",
    "error",
  ]),
  error: z.string().optional(),
});
export type ReserveOutput = z.infer<typeof ReserveOutput>;

export const PrepareInput = z.object({
  workspace_id: WorkspaceId,
  lifecycle: Lifecycle,
});
export type PrepareInput = z.infer<typeof PrepareInput>;

export const PrepareOutput = z.object({
  workspace_id: WorkspaceId,
  files_written: z.array(z.string()),
  beads_hydrated: z.boolean(),
  status: z.enum(["ok", "partial", "error"]),
  error: z.string().optional(),
});
export type PrepareOutput = z.infer<typeof PrepareOutput>;

export const SyncInput = z.object({
  workspace_id: WorkspaceId,
});
export type SyncInput = z.infer<typeof SyncInput>;

export const SyncOutput = z.object({
  workspace_id: WorkspaceId,
  ignore_synced: z.boolean(),
  tooling_drift_corrected: z.array(z.string()),
  status: z.enum(["ok", "noop", "error"]),
  error: z.string().optional(),
});
export type SyncOutput = z.infer<typeof SyncOutput>;

export const ServiceInput = z.object({
  workspace_id: WorkspaceId,
  action: z.enum(["start", "stop"]),
  auto: z.boolean().default(false),
});
export type ServiceInput = z.infer<typeof ServiceInput>;

export const ServiceOutput = z.object({
  workspace_id: WorkspaceId,
  status: z.enum([
    "started",
    "stopped",
    "skipped",
    "no-profile",
    "error",
  ]),
  profile: z.string().optional(),
  compose_files: z.array(z.string()),
  error: z.string().optional(),
});
export type ServiceOutput = z.infer<typeof ServiceOutput>;

export const TeardownInput = z.object({
  workspace_id: WorkspaceId,
  force: z.boolean().default(false),
});
export type TeardownInput = z.infer<typeof TeardownInput>;

export const TeardownOutput = z.object({
  workspace_id: WorkspaceId,
  status: z.enum(["torn-down", "skipped", "error"]),
  cleaned: z.array(z.string()),
  error: z.string().optional(),
});
export type TeardownOutput = z.infer<typeof TeardownOutput>;

export const WORKSPACE_VERBS = [
  "reserve",
  "materialize",
  "prepare",
  "sync",
  "service",
  "teardown",
] as const;
export type WorkspaceVerb = (typeof WORKSPACE_VERBS)[number];

export const WORKSPACE_INPUT_SCHEMAS = {
  reserve: ReserveInput,
  materialize: MaterializeInput,
  prepare: PrepareInput,
  sync: SyncInput,
  service: ServiceInput,
  teardown: TeardownInput,
} as const satisfies Record<WorkspaceVerb, z.ZodTypeAny>;

export const WORKSPACE_OUTPUT_SCHEMAS = {
  reserve: ReserveOutput,
  materialize: MaterializeOutput,
  prepare: PrepareOutput,
  sync: SyncOutput,
  service: ServiceOutput,
  teardown: TeardownOutput,
} as const satisfies Record<WorkspaceVerb, z.ZodTypeAny>;
