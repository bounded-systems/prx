/**
 * Dolt actor contract (GH-2009).
 *
 * Zod input/output schemas for the nine accepts of the `dolt` actor:
 * provision, start, stop, status, adopt, reconcile, sync-all, policy,
 * supervise. Every driver (start/stop/status/adopt from GH-555;
 * install + DSN handoff from GH-557 surfaced as a `start` output
 * field; launchd supervisor from GH-568; provision pipeline from
 * GH-1685; cross-repo sync-all from GH-1702; auto-push policy from
 * GH-1938; per-host mirror refresh from the GH-826 follow-ups) shares
 * this contract. The contract MUST NOT leak driver vocabulary: no
 * "worktrunk", "homebrew", "launchd" (despite the `supervise` verb —
 * the verb is platform-neutral; the macOS plist is an implementation
 * detail), "bd init", "dolthub-api", "hydrate", "mainx". If a driver
 * adds a field here, it has stopped being a driver.
 *
 * Lifecycle states are provisioned → running ⇄ healthy → stopped →
 * orphaned. `dolt_server_id` is a 12-hex stable identifier for a
 * per-repo dolt sql-server (sha256({host_repo_slug, .beads/dolt/<db>
 * path}) truncated; matches workspace_id derivation in
 * src/workspace/actor.ts). The actor computes it; drivers must not
 * supply it.
 *
 * Scope class is `type::decision` — this file is the contract
 * artifact. The runtime that holds the ledger, arbitrates ports, and
 * talks to `dolt sql-server` lands in re-shaped child tickets
 * (GH-555/557/568/1685/1938; GH-1702 stays on its current shape).
 */

import { z } from "zod";

export const Lifecycle = z.enum(["provisioned", "running", "healthy", "stopped", "orphaned"]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const DoltServerId = z.string().regex(/^[a-f0-9]{12}$/);
export type DoltServerId = z.infer<typeof DoltServerId>;

// Canonical per-repo `dolt_database` identifier in reverse-DNS form
// `io_github_<owner>_<repo>` — D0 of GH-1685 standardized on the *live*
// on-disk convention (e.g. `io_github_pushd_supply_plan_design`) over the
// older `{host}__{owner}__{repo}` shape. Produced from a GitHub origin by
// `canonicalDoltDatabase()` (src/pr-state/github.ts), which collapses each
// reverse-DNS segment's non-alphanumerics to `_`. Lowercase, single-`_`
// joined — boundary-ambiguous by design, so never parse it back into
// owner/repo; always derive forward from the origin.
export const DOLT_DATABASE_NAME_PATTERN = /^io_github(_[a-z0-9]+)+$/;
export const RepoSlug = z.string().regex(DOLT_DATABASE_NAME_PATTERN);
export type RepoSlug = z.infer<typeof RepoSlug>;

export const Owner = z.enum(["prx", "external"]);
export type Owner = z.infer<typeof Owner>;

// ─── provision (GH-1685) ─────────────────────────────────────────────
export const ProvisionInput = z.object({
  repo_path: z.string().min(1),
  dolt_database: RepoSlug.optional(),
});
export type ProvisionInput = z.infer<typeof ProvisionInput>;

export const ProvisionOutput = z.object({
  dolt_server_id: DoltServerId,
  dolt_database: RepoSlug,
  status: z.enum(["provisioned", "exists", "error"]),
  error: z.string().optional(),
});
export type ProvisionOutput = z.infer<typeof ProvisionOutput>;

// ─── start (GH-555 + GH-557 DSN handoff) ─────────────────────────────
export const StartInput = z.object({
  repo_path: z.string().min(1),
  detach: z.boolean().default(false),
});
export type StartInput = z.infer<typeof StartInput>;

export const StartOutput = z.object({
  dolt_server_id: DoltServerId,
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  dsn: z.string().min(1),
  owner: Owner,
  status: z.enum(["started", "exists", "error"]),
  error: z.string().optional(),
});
export type StartOutput = z.infer<typeof StartOutput>;

// ─── stop (GH-555) ───────────────────────────────────────────────────
export const StopInput = z.object({
  dolt_server_id: DoltServerId,
});
export type StopInput = z.infer<typeof StopInput>;

export const StopOutput = z.object({
  dolt_server_id: DoltServerId,
  status: z.enum(["stopped", "not-running", "error"]),
  error: z.string().optional(),
});
export type StopOutput = z.infer<typeof StopOutput>;

// ─── status (GH-555; read; emits HEALTHY/ORPHANED) ───────────────────
export const StatusInput = z.object({
  repo_path: z.string().min(1),
});
export type StatusInput = z.infer<typeof StatusInput>;

export const StatusOutput = z.object({
  dolt_server_id: DoltServerId,
  lifecycle: Lifecycle,
  pid: z.number().int().positive().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  dsn: z.string().nullable(),
  owner: Owner.nullable(),
  healthy: z.boolean(),
  // Commits on the reachable server's `main` not yet pushed to its
  // configured origin remote — the stranding signal the GH-2154 incident
  // missed. null when undeterminable (server unreachable or the count
  // query failed); never blocks the connectivity verdict.
  unpushed_commits: z.number().int().min(0).nullable(),
  error: z.string().optional(),
});
export type StatusOutput = z.infer<typeof StatusOutput>;

// ─── adopt (GH-555 §adopt — explicit legacy-import escape valve) ─────
export const AdoptInput = z.object({
  repo_path: z.string().min(1),
  pid: z.number().int().positive(),
});
export type AdoptInput = z.infer<typeof AdoptInput>;

export const AdoptOutput = z.object({
  dolt_server_id: DoltServerId,
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  status: z.enum(["adopted", "already-owned", "error"]),
  error: z.string().optional(),
});
export type AdoptOutput = z.infer<typeof AdoptOutput>;

// ─── reconcile (existing top-level verb; migrates here in a child) ───
export const ReconcileInput = z.object({
  repo_path: z.string().min(1),
  dryRun: z.boolean().default(false),
  resolve: z.enum(["schema-prefer-remote"]).optional(),
});
export type ReconcileInput = z.infer<typeof ReconcileInput>;

export const ReconcileOutput = z.object({
  dolt_server_id: DoltServerId,
  status: z.enum(["reconciled", "noop", "schema-conflict", "error"]),
  commits_pushed: z.number().int().min(0),
  error: z.string().optional(),
});
export type ReconcileOutput = z.infer<typeof ReconcileOutput>;

// ─── sync-all (GH-1702 — fan-out over reconcile) ─────────────────────
export const SyncAllInput = z.object({
  pushOnly: z.boolean().default(false),
  pullOnly: z.boolean().default(false),
  repoSlug: RepoSlug.optional(),
});
export type SyncAllInput = z.infer<typeof SyncAllInput>;

export const SyncAllOutput = z.object({
  repos_reconciled: z.number().int().min(0),
  repos_failed: z.number().int().min(0),
  status: z.enum(["ok", "partial", "error"]),
  error: z.string().optional(),
});
export type SyncAllOutput = z.infer<typeof SyncAllOutput>;

// ─── policy (GH-1938 — auto-push / auto-commit; idempotent) ──────────
export const PolicyInput = z.object({
  key: z.enum(["dolt.auto-push", "dolt.auto-commit"]),
  value: z.boolean(),
  scope: z.enum(["all-managed-workspaces", "repo"]),
});
export type PolicyInput = z.infer<typeof PolicyInput>;

export const PolicyOutput = z.object({
  key: z.enum(["dolt.auto-push", "dolt.auto-commit"]),
  value: z.boolean(),
  scope: z.enum(["all-managed-workspaces", "repo"]),
  workspaces_updated: z.number().int().min(0),
  status: z.enum(["applied", "noop", "error"]),
  error: z.string().optional(),
});
export type PolicyOutput = z.infer<typeof PolicyOutput>;

// ─── supervise (GH-568 — launchd hand-off; Darwin-only no-op elsewhere)
export const SuperviseInput = z.object({
  action: z.enum(["enable", "disable", "status"]),
});
export type SuperviseInput = z.infer<typeof SuperviseInput>;

export const SuperviseOutput = z.object({
  action: z.enum(["enable", "disable", "status"]),
  platform_supported: z.boolean(),
  status: z.enum(["enabled", "disabled", "not-supported", "error"]),
  error: z.string().optional(),
});
export type SuperviseOutput = z.infer<typeof SuperviseOutput>;

export const DOLT_VERBS = [
  "provision",
  "start",
  "stop",
  "status",
  "adopt",
  "reconcile",
  "sync-all",
  "policy",
  "supervise",
] as const;
export type DoltVerb = (typeof DOLT_VERBS)[number];

export const DOLT_INPUT_SCHEMAS = {
  provision: ProvisionInput,
  start: StartInput,
  stop: StopInput,
  status: StatusInput,
  adopt: AdoptInput,
  reconcile: ReconcileInput,
  "sync-all": SyncAllInput,
  policy: PolicyInput,
  supervise: SuperviseInput,
} as const satisfies Record<DoltVerb, z.ZodTypeAny>;

export const DOLT_OUTPUT_SCHEMAS = {
  provision: ProvisionOutput,
  start: StartOutput,
  stop: StopOutput,
  status: StatusOutput,
  adopt: AdoptOutput,
  reconcile: ReconcileOutput,
  "sync-all": SyncAllOutput,
  policy: PolicyOutput,
  supervise: SuperviseOutput,
} as const satisfies Record<DoltVerb, z.ZodTypeAny>;

// GH-2129: the single declarative source of truth for the `prx dolt <verb>`
// CLI surface. Each verb names (1) the dispatcher route the namespace rewrite
// rewrites to, and (2) the tracking issue that owns its implementation. Today
// only `reconcile` routes to a real command; the other eight route to
// `dolt-stub`, which emits a typed `not-implemented` outcome naming the
// tracking ticket instead of the historic `Unknown dolt subcommand` string.
// When a child epic wires its verb, the only contract change here is flipping
// that row's `route` from "dolt-stub" to the real command name — the registry,
// dispatcher, error messages, and parity tests all derive from this table.
export const DOLT_VERB_DISPATCH = {
  provision: { route: "dolt-stub", tracking: "GH-1685" },
  // prx-82b 2e.3: the host dolt-server start is RETIRED — the pod's dolt-box is
  // the server now (`prx pod up`). Routed to the stub (no host server start).
  start: { route: "dolt-stub", tracking: "GH-555" },
  stop: { route: "dolt-stub", tracking: "GH-555" },
  status: { route: "dolt-status", tracking: "GH-555" },
  adopt: { route: "dolt-stub", tracking: "GH-555" },
  reconcile: { route: "dolt-reconcile", tracking: "GH-1016" },
  "sync-all": { route: "dolt-stub", tracking: "GH-1702" },
  policy: { route: "dolt-stub", tracking: "GH-1938" },
  supervise: { route: "dolt-stub", tracking: "GH-568" },
} as const satisfies Record<DoltVerb, { route: string; tracking: string }>;

// GH-2129: typed outcome for an unwired dolt verb. The stub handler emits this
// shape (plain text by default, JSON under `--format=json`) and exits non-zero
// so an operator script can tell "not yet implemented" from a real failure.
export const DoltStubOutput = z.object({
  verb: z.enum(DOLT_VERBS),
  status: z.literal("not-implemented"),
  tracking: z.string().regex(/^GH-\d+$/),
  message: z.string(),
});
export type DoltStubOutput = z.infer<typeof DoltStubOutput>;
