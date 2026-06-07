/**
 * `prx gc <verb>` CLI surface (GH-2026/GH-2327).
 *
 * Thin shell over the `gc` actor contract: parse argv → validate against the
 * matching `*Input` schema → dispatch to the actor → emit the matching
 * `*Output` schema (plain or `--json`). The boundary-layer Zod types in
 * `./schema.ts` are the source of truth; this file only surfaces the flags and
 * lets the schema defaults carry the sweep-vs-targeted safety rule:
 *   - sweep `run` is dry-run by default (`--apply` flips it);
 *   - targeted `teardown` acts by default (`--dry-run` opts out).
 */

import { parseArgs } from "node:util";

import { deleteBlob, listBlobs, listRefs, readBlob } from "../../plan-store/cas.ts";
import type { applyParityChainActions } from "../../pr-state/cli.ts";
import { buildParityChain } from "../../pr-state/github.ts";
import { RepoGcError, runRepoGc } from "../../pr-state/repo_gc.ts";
import { loadRepoInventoryConfig } from "../../pr-state/repos.ts";
import { resolveWorktreePath } from "../../tools/worktree_path.ts";
import { runInventory, runRun, runTeardown } from "./actor.ts";
import type { CasGcOps, HooksGcOps, RepoGcOps } from "./drivers/registry.ts";
import {
	GC_VERBS,
	InventoryInput,
	InventoryOutput,
	RunInput,
	RunOutput,
	TeardownInput,
	TeardownOutput,
	type GcVerb,
	type InventoryOutput as InventoryOutputT,
	type RunOutput as RunOutputT,
	type TeardownOutput as TeardownOutputT,
} from "./schema.ts";

/**
 * Deprecation hint for the `prx prune` → `prx gc` alias (2l4ua). Per-unit
 * `prx prune --ticket <id>` remaps faithfully to `prx gc teardown <id>`; the
 * batch/scope/session modes have no faithful gc equivalent yet, so they stay on
 * `prx prune` until gc grows a full-teardown sweep — then `prx prune` is removed.
 */
export const PRX_PRUNE_GC_ALIAS_HINT =
	"`prx prune` is deprecated. Per-unit teardown is now `prx gc teardown <GH-NNN>`; " +
	"batch/scope/session teardown stays on `prx prune` until gc grows a full-teardown sweep, " +
	"then `prx prune` is removed.";

export type GcCliFormat = "plain" | "json";

export type GcCliArgs = {
	verb: GcVerb;
	format: GcCliFormat;
	// inventory / run
	component?: string | undefined;
	// run
	apply?: boolean | undefined;
	capability?: string | undefined;
	// teardown
	dryRun?: boolean | undefined;
	unit?: string | undefined;
};

export class GcCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GcCliError";
	}
}

/**
 * Parse `prx gc <verb> [flags]`. Returns a strongly-typed `GcCliArgs`.
 * Throws `GcCliError` on bad argv. `teardown` takes a positional `unit`.
 */
export function parseGcArgs(argv: readonly string[]): GcCliArgs {
	if (argv.length === 0) {
		throw new GcCliError(`gc requires a verb: ${GC_VERBS.join(", ")}`);
	}
	const verb = argv[0] ?? "";
	const rest = argv.slice(1);
	if (!(GC_VERBS as readonly string[]).includes(verb)) {
		throw new GcCliError(
			`Unknown gc verb: ${verb}. Expected: ${GC_VERBS.join(", ")}`,
		);
	}
	const { values, positionals } = parseArgs({
		args: rest,
		options: {
			format: { type: "string", default: "plain" },
			component: { type: "string" },
			apply: { type: "boolean", default: false },
			capability: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
		strict: true,
		// Only `teardown` carries a positional (the named unit).
		allowPositionals: verb === "teardown",
	});
	const format = values.format === "json" ? "json" : "plain";
	return {
		verb: verb as GcVerb,
		format,
		component: values.component,
		apply: values.apply ?? false,
		capability: values.capability,
		dryRun: values["dry-run"] ?? false,
		unit: verb === "teardown" ? positionals[0] : undefined,
	};
}

export type GcCliDeps = {
	cwd?: string;
	buildParityChain?: typeof buildParityChain;
	applyParityChainActions?: typeof applyParityChainActions;
	cas?: CasGcOps;
	/** Injected from the CLI layer (`pr-state/cli.ts` gc dispatch); absent ⇒ the
	 * hooks driver no-ops. Lazy resolver, so a non-hooks run skips repo discovery. */
	hooks?: HooksGcOps;
	/** Defaults to `runRepoGc` over the resolved inventory config + wt root; tests override. */
	repo?: RepoGcOps;
};

export type GcCliResult = {
	exitCode: number;
	output: string;
	payload: InventoryOutputT | RunOutputT | TeardownOutputT;
};

// Exit-zero statuses across all three verbs (everything else → exit 1):
//   error, partial, capability-required, not-found.
const SUCCESS_STATUSES = new Set<string>([
	"clean",
	"reclaimable",
	"swept",
	"would-sweep",
	"torn-down",
	"would-tear-down",
]);

/**
 * Dispatch a parsed `GcCliArgs` to the actor and produce a `GcCliResult`.
 * Exit codes derive from the output status (see `SUCCESS_STATUSES`).
 */
export async function runGcCli(args: GcCliArgs, deps: GcCliDeps = {}): Promise<GcCliResult> {
	const cwd = deps.cwd ?? process.cwd();
	// Shared deps for the sweep verbs (inventory/run): the driver registry gets
	// the runtime helpers injected (never statically imported into the actor).
	const sweepDeps = {
		repoPath: cwd,
		buildParityChain: deps.buildParityChain ?? buildParityChain,
		applyParityChainActions: deps.applyParityChainActions,
		cas: deps.cas ?? { listRefs, readBlob, listBlobs, deleteBlob },
		// hooks has no safe in-module default (needs cli.ts's defaultHooksPath +
		// repo discovery), so it's injected from the dispatch site or the driver
		// no-ops. Mirrors how buildParityChain is threaded.
		hooks: deps.hooks,
		// repo's deps are also safe leaf imports (runRepoGc + the inventory
		// config + wt-root resolvers), defaulted here like cas. Lazy: the report
		// scan runs only when the repo component is marked/swept. yes:true — the
		// gc capability token is the confirmation (no interactive prompt).
		repo: deps.repo ?? {
			run: (apply: boolean) => {
				try {
					return runRepoGc({
						config: loadRepoInventoryConfig(cwd),
						wtRoot: resolveWorktreePath().base,
						apply,
						yes: true,
					});
				} catch (err) {
					// No `.prx/repos` inventory in this checkout = nothing for repo-gc
					// to reclaim; the fan-out shouldn't report `partial` just because
					// the inventory is absent (mirrors cas → empty store). The
					// targeted `prx repo gc` still surfaces this as an error.
					if (err instanceof RepoGcError) {
						return { apply, scanned: 0, orphansFound: 0, swept: 0, refused: 0, cleanedBytes: 0, durationMs: 0, entries: [] };
					}
					throw err;
				}
			},
		},
	};

	if (args.verb === "inventory") {
		const input = InventoryInput.parse({
			...(args.component !== undefined ? { component: args.component } : {}),
		});
		const out = await runInventory(input, sweepDeps);
		return finalize("inventory", out, args.format, InventoryOutput);
	}

	if (args.verb === "run") {
		const input = RunInput.parse({
			...(args.component !== undefined ? { component: args.component } : {}),
			apply: args.apply ?? false,
			...(args.capability !== undefined ? { capability: args.capability } : {}),
		});
		const out = await runRun(input, sweepDeps);
		return finalize("run", out, args.format, RunOutput);
	}

	if (args.verb === "teardown") {
		if (!args.unit) {
			throw new GcCliError(
				"gc teardown requires a unit, e.g. `prx gc teardown GH-1234`",
			);
		}
		const input = TeardownInput.parse({
			unit: args.unit,
			dry_run: args.dryRun ?? false,
		});
		const out = runTeardown(input, {
			repoPath: cwd,
			buildParityChain: deps.buildParityChain ?? buildParityChain,
			applyParityChainActions: deps.applyParityChainActions,
		});
		return finalize("teardown", out, args.format, TeardownOutput);
	}

	throw new GcCliError(`Unhandled gc verb: ${args.verb}`);
}

type AnyGcOutput = InventoryOutputT | RunOutputT | TeardownOutputT;

function finalize<T extends AnyGcOutput>(
	verb: GcVerb,
	out: T,
	format: GcCliFormat,
	schema: { parse: (v: unknown) => T },
): GcCliResult {
	const validated = schema.parse(out);
	const exitCode = SUCCESS_STATUSES.has(validated.status) ? 0 : 1;
	const output =
		format === "json"
			? JSON.stringify(validated, null, 2)
			: formatPlain(verb, validated);
	return { exitCode, output, payload: validated };
}

function formatPlain(verb: GcVerb, out: AnyGcOutput): string {
	const lines = [`gc.${verb}: ${out.status}`];
	if ("findings" in out) {
		lines.push(`  findings=${out.findings.length}`);
	}
	if ("dry_run" in out) {
		lines.push(`  dry_run=${out.dry_run}`);
	}
	if ("reclaimed" in out) {
		lines.push(`  reclaimed=${out.reclaimed.length}`);
	}
	if ("failed" in out && out.failed.length > 0) {
		lines.push(`  failed=${out.failed.map((f) => f.component).join(",")}`);
	}
	if ("unit" in out) {
		lines.push(`  unit=${out.unit}`);
	}
	if ("removed" in out && out.removed.length > 0) {
		lines.push(`  removed=${out.removed.join(",")}`);
	}
	if (out.error) {
		lines.push(`  error=${out.error}`);
	}
	return lines.join("\n");
}
