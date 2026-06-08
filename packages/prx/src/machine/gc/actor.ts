/**
 * gc actor — execution side of the housekeeping contract (GH-2026/GH-2327).
 *
 * Three verbs across two classes (see `./schema.ts`):
 *   - sweep    (`inventory`, `run`) — discover/reclaim across the whole system.
 *   - targeted (`teardown`)         — full teardown of one named work-unit.
 *
 * `inventory`/`run` fan out over the `GcComponent` driver registry
 * (`./drivers/registry.ts`) with per-component failure isolation; `run` gates
 * destructive components (`GC_DESTRUCTIVE_COMPONENTS`) behind a capability token
 * via `assertGcCapability` (two-phase mark→sweep). Drivers receive injected deps,
 * so this module never statically imports `src/pr-state/cli.ts`.
 *
 * `teardown` is wired NOW to the existing prune teardown path: it reuses
 * `buildParityChain` + `applyParityChainActions` (the same helpers `prx prune`
 * drives). Both are injected as deps so this module never statically imports
 * `src/pr-state/cli.ts` (avoids an ESM cycle) and so tests can drive the
 * action→class mapping without touching git. The `prune`→`gc` rename and the
 * `prx prune` alias-deprecation stay out of scope (sibling `2l4ua`).
 */

import type { SurfaceSyncAction } from "@bounded-systems/surface-sync";

import type { applyParityChainActions } from "../../pr-state/cli.ts";
import type { buildParityChain } from "../../pr-state/github.ts";
import { assertGcCapability, markFindings } from "./capability.ts";
import { buildGcRegistry, type GcDriverDeps } from "./drivers/registry.ts";
import {
	GcComponent,
	type GcClass,
	type GcFinding,
	type InventoryInput,
	type InventoryOutput,
	type RunInput,
	type RunOutput,
	type TeardownInput,
	type TeardownOutput,
} from "./schema.ts";

/** Sweep deps (inventory/run). Same injected shape as {@link GcTeardownDeps}. */
export type GcSweepDeps = GcDriverDeps;

/** Tally findings by their `GcClass`. */
function countByClass(findings: readonly GcFinding[]): Partial<Record<GcClass, number>> {
	const by: Partial<Record<GcClass, number>> = {};
	for (const f of findings) by[f.class] = (by[f.class] ?? 0) + 1;
	return by;
}

/** Read-only discovery (sweep class). Fans out over the driver registry,
 * calling each driver's `mark()` with per-component failure isolation. */
export async function runInventory(
	input: InventoryInput,
	deps: GcSweepDeps,
): Promise<InventoryOutput> {
	const registry = buildGcRegistry(deps);
	const targets = input.component ? [input.component] : GcComponent.options;
	const findings: GcFinding[] = [];
	const failures: string[] = [];
	let ran = 0;
	for (const component of targets) {
		const driver = registry[component];
		if (!driver) continue;
		ran += 1;
		try {
			findings.push(...(await driver.mark()));
		} catch (err) {
			failures.push(`${component}: ${errMessage(err)}`);
		}
	}
	// InventoryOutput carries no per-component `failed[]`; surface failures in
	// `error`, and only flip status to `error` when every attempted driver failed.
	const status: InventoryOutput["status"] =
		ran > 0 && failures.length === ran
			? "error"
			: findings.length > 0
				? "reclaimable"
				: "clean";
	return {
		status,
		findings,
		by_class: countByClass(findings),
		...(failures.length > 0 ? { error: failures.join("; ") } : {}),
	};
}

/** Sweep reclaim (dry-run by default; `apply` opts into mutation). Fans out over
 * the driver registry with per-component failure isolation; destructive
 * components require a capability token before `apply` will sweep them. */
export async function runRun(input: RunInput, deps: GcSweepDeps): Promise<RunOutput> {
	const registry = buildGcRegistry(deps);
	const targets = input.component ? [input.component] : GcComponent.options;
	const dryRun = !input.apply;
	const reclaimed: GcFinding[] = [];
	const failed: { component: GcComponent; error: string }[] = [];
	let ran = 0;
	let gated = 0;
	for (const component of targets) {
		const driver = registry[component];
		if (!driver) continue;
		ran += 1;
		try {
			const findings = await driver.mark();
			if (dryRun) {
				// Dry-run never gates or sweeps: report the would-be-reclaimed set.
				reclaimed.push(...findings);
				continue;
			}
			const verdict = assertGcCapability({
				component,
				apply: true,
				...(input.capability !== undefined ? { capability: input.capability } : {}),
			});
			if (verdict.outcome === "capability-required") {
				gated += 1;
				continue; // destructive component without the token — never swept
			}
			// Two-phase mark→sweep; the mark is keyed per-component so refs from a
			// later driver can't collide in `sweepableFromMark`.
			const mark = markFindings(component, findings);
			const result = await driver.sweep(
				mark,
				input.capability !== undefined ? { capability: input.capability } : {},
			);
			reclaimed.push(...result.reclaimed);
			if (result.failed) failed.push({ component, error: result.failed });
		} catch (err) {
			failed.push({ component, error: errMessage(err) });
		}
	}
	return {
		status: runStatus({ ran, failed: failed.length, gated, dryRun, reclaimed: reclaimed.length }),
		dry_run: dryRun,
		reclaimed,
		by_class: countByClass(reclaimed),
		failed,
	};
}

/** Run status precedence: error > partial > capability-required > would-sweep/swept > clean. */
function runStatus(s: {
	ran: number;
	failed: number;
	gated: number;
	dryRun: boolean;
	reclaimed: number;
}): RunOutput["status"] {
	if (s.ran === 0) return "clean";
	if (s.failed === s.ran) return "error"; // every attempted driver failed
	if (s.failed > 0) return "partial"; // some failed, some did not
	if (s.gated > 0) return "capability-required"; // gated, none failed
	if (s.dryRun) return s.reclaimed > 0 ? "would-sweep" : "clean";
	return s.reclaimed > 0 ? "swept" : "clean";
}

/** Deps for the prune-wired `teardown` path. Injected for testability + to
 * keep this module free of a static `pr-state/cli.ts` import. */
export type GcTeardownDeps = {
	repoPath: string;
	buildParityChain: typeof buildParityChain;
	/** Only required on the apply path (omitted/dry-run never calls it). */
	applyParityChainActions?: typeof applyParityChainActions | undefined;
};

// Stable emission order for the teardown footprint classes. `beads` is listed
// for completeness but never emitted today — the prune chain has no bd-close
// action type.
const REMOVED_ORDER = [
	"worktree",
	"beads",
	"branch",
	"gh-verified",
] as const satisfies readonly TeardownOutput["removed"][number][];

/** Map prune-chain actions onto the teardown footprint classes. */
function mapRemoved(actions: readonly SurfaceSyncAction[]): TeardownOutput["removed"] {
	const seen = new Set<TeardownOutput["removed"][number]>();
	for (const action of actions) {
		switch (action.type) {
			case "delete_worktree":
				seen.add("worktree");
				break;
			case "delete_local_branch":
			case "delete_remote_branch":
				seen.add("branch");
				break;
			case "close_issue":
				seen.add("gh-verified");
				break;
			default:
				// create_*/push/open_* are not teardown footprint — ignore.
				break;
		}
	}
	return REMOVED_ORDER.filter((cls) => seen.has(cls));
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Targeted teardown of one named work-unit (acts by default). Resolves the
 * footprint via `buildParityChain({ mode: "prune", ticket })` and, unless
 * `dry_run`, applies it via `applyParityChainActions`.
 */
export function runTeardown(input: TeardownInput, deps: GcTeardownDeps): TeardownOutput {
	let result: ReturnType<typeof buildParityChain>;
	try {
		result = deps.buildParityChain(deps.repoPath, {
			mode: "prune",
			ticket: input.unit,
			apply: !input.dry_run,
		});
	} catch (err) {
		return { unit: input.unit, status: "error", removed: [], error: errMessage(err) };
	}

	const removed = mapRemoved(result.actions);

	if (result.actions.length === 0) {
		return { unit: input.unit, status: "not-found", removed: [] };
	}

	if (input.dry_run) {
		return { unit: input.unit, status: "would-tear-down", removed };
	}

	if (!deps.applyParityChainActions) {
		return {
			unit: input.unit,
			status: "error",
			removed,
			error: "gc teardown --apply requires applyParityChainActions dependency",
		};
	}

	try {
		const applyResults = deps.applyParityChainActions(result, deps.repoPath);
		const anyFailed = applyResults.some((r) => r.status !== 0);
		return { unit: input.unit, status: anyFailed ? "partial" : "torn-down", removed };
	} catch (err) {
		return { unit: input.unit, status: "error", removed, error: errMessage(err) };
	}
}
