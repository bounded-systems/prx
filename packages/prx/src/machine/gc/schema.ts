/**
 * gc actor contract (GH-2026).
 *
 * The `gc` actor is the unified housekeeping surface: one actor coordinating
 * the reclaim/reconcile work previously fragmented across 10+ sweep-shaped
 * verbs in 7+ namespaces. It also fully absorbs `prx prune` (operator decision
 * 2026-05-27): per-unit teardown becomes the `teardown` verb here.
 *
 * Two verb CLASSES share this contract, differing only in default safety:
 *   - sweep    (`inventory`, `run`): discover-and-reclaim across the whole
 *              system. No named target. `run` is DRY-RUN BY DEFAULT and opts
 *              into mutation via `apply`; destructive components additionally
 *              require an explicit `capability`.
 *   - targeted (`teardown`): full teardown of a work-unit the operator NAMED.
 *              Acts by default (the operator already chose the blast radius).
 *
 * Drivers are a `component` DIMENSION, not separate verbs — `prx gc run
 * --component cas` rather than `prx gc cas`. This keeps the CLI surface to
 * three verbs while `run`/`inventory` fan out over the driver list with
 * per-component failure isolation.
 *
 * Like every actor contract here, this MUST NOT leak driver vocabulary: no
 * "worktrunk", no "dolt server", no blob-store internals. A driver that needs a
 * new field here has stopped being a driver.
 */

import { z } from "zod";

/** State classification a driver reports for a reclaimable item. */
export const GcClass = z.enum([
	"orphan",
	"stale",
	"drift",
	"missed-close",
	"dup",
]);
export type GcClass = z.infer<typeof GcClass>;

/**
 * Housekeeping components (drivers). Each reshapes an existing sweep verb;
 * `cas` (GH-2312) is the first driver that DELETES CONTENT (plan-store blobs),
 * vs. the others which reconcile metadata. `worktree` folds GH-803/GH-736.
 */
export const GcComponent = z.enum([
	"chain", // prx chain prune — stale parity-chain leaves
	"derive", // prx derive drift — drifted chains + invariants
	"sync", // prx sync issues — GH <-> bd reconcile
	"triage", // prx triage close-stale + status drift/orphans
	"postmerge", // prx submit postmerge — missed-autoclose sweep
	"workspace", // prx workspace sync — tooling-file drift
	"repo", // prx repo backfill + repo_gc — stale inventory / migration orphans
	"dolt", // prx dolt reconcile — dolt push reconcile
	"hooks", // prx hooks status — git hooks path drift
	"tmux", // prx tmux reconcile — tmux config drift
	"worktree", // orphaned-worktree sweep (folds GH-803/GH-736)
	"cas", // plan-store CAS blob GC (GH-2312) — DELETES CONTENT
]);
export type GcComponent = z.infer<typeof GcComponent>;

/**
 * Components whose sweep deletes content/operator state and therefore require
 * an explicit capability token before `run --apply` will act on them.
 */
export const GC_DESTRUCTIVE_COMPONENTS = [
	"cas",
	"worktree",
	"chain", // deletes parity-chain branch leaves (incl. the remote branch)
	"repo", // rm -rf's embedded-dolt migration orphans
] as const satisfies readonly GcComponent[];

/** One reclaimable item discovered or acted on by a driver. */
export const GcFinding = z.object({
	component: GcComponent,
	class: GcClass,
	/** The thing: a blob sha, a worktree path, a bd id, a ref name, … */
	ref: z.string(),
	detail: z.string().optional(),
	reclaim_bytes: z.number().int().nonnegative().optional(),
});
export type GcFinding = z.infer<typeof GcFinding>;

// --- inventory (sweep class; read-only discovery, never mutates) ---
export const InventoryInput = z.object({
	/** Omitted = every component. */
	component: GcComponent.optional(),
});
export type InventoryInput = z.infer<typeof InventoryInput>;

export const InventoryOutput = z.object({
	status: z.enum(["clean", "reclaimable", "error"]),
	findings: z.array(GcFinding),
	by_class: z.partialRecord(GcClass, z.number().int().nonnegative()),
	error: z.string().optional(),
});
export type InventoryOutput = z.infer<typeof InventoryOutput>;

// --- run (sweep class; DRY-RUN BY DEFAULT, opt-in mutation) ---
export const RunInput = z.object({
	/** Omitted = every component (batch `run --all`). */
	component: GcComponent.optional(),
	/** false (default) = dry-run; true = actually reclaim. */
	apply: z.boolean().default(false),
	/** Required to `apply` a GC_DESTRUCTIVE_COMPONENTS sweep. */
	capability: z.string().optional(),
});
export type RunInput = z.infer<typeof RunInput>;

export const RunOutput = z.object({
	status: z.enum([
		"clean", // nothing reclaimable
		"swept", // applied; items reclaimed
		"would-sweep", // dry-run; items WOULD be reclaimed
		"capability-required", // a destructive component needs a capability token
		"partial", // some components failed; others succeeded (failure isolation)
		"error",
	]),
	dry_run: z.boolean(),
	/** Acted-on (or, in dry-run, would-be-acted-on) items. */
	reclaimed: z.array(GcFinding),
	by_class: z.partialRecord(GcClass, z.number().int().nonnegative()),
	/** Per-component failures — one driver failing must not abort the others. */
	failed: z.array(z.object({ component: GcComponent, error: z.string() })),
	error: z.string().optional(),
});
export type RunOutput = z.infer<typeof RunOutput>;

// --- teardown (targeted class; ACTS BY DEFAULT — absorbs `prx prune`) ---
export const TeardownInput = z.object({
	/** The work-unit id the operator named, e.g. "GH-1234". */
	unit: z.string().min(1),
	/** Targeted teardown acts by default; opt OUT with dry_run. */
	dry_run: z.boolean().default(false),
});
export type TeardownInput = z.infer<typeof TeardownInput>;

export const TeardownOutput = z.object({
	unit: z.string(),
	status: z.enum([
		"torn-down",
		"would-tear-down",
		"not-found",
		"partial",
		"error",
	]),
	/** Footprint classes removed (or, in dry-run, that would be removed). */
	removed: z.array(
		z.enum(["worktree", "tmux", "beads", "branch", "gh-verified"]),
	),
	error: z.string().optional(),
});
export type TeardownOutput = z.infer<typeof TeardownOutput>;

export const GC_VERBS = ["inventory", "run", "teardown"] as const;
export type GcVerb = (typeof GC_VERBS)[number];

/** Verb class drives the CLI default-safety rule (sweep = dry-run, targeted = act). */
export const GC_VERB_CLASS = {
	inventory: "sweep",
	run: "sweep",
	teardown: "targeted",
} as const satisfies Record<GcVerb, "sweep" | "targeted">;

export const GC_INPUT_SCHEMAS = {
	inventory: InventoryInput,
	run: RunInput,
	teardown: TeardownInput,
} as const satisfies Record<GcVerb, z.ZodTypeAny>;

export const GC_OUTPUT_SCHEMAS = {
	inventory: InventoryOutput,
	run: RunOutput,
	teardown: TeardownOutput,
} as const satisfies Record<GcVerb, z.ZodTypeAny>;
