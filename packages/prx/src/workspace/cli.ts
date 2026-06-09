/**
 * `prx workspace <verb>` CLI surface (GH-1978).
 *
 * Thin wrapper that parses argv → validates against the matching
 * `*Input` schema → dispatches to the actor → emits the matching
 * `*Output` schema (plain or `--json`). Drivers (worktrunk today;
 * devcontainer / nix devShell / CI pre-job tomorrow) call into the
 * actor only through this surface — the actor module never imports
 * driver code, and this surface never imports driver code.
 */

import { parseArgs } from "node:util";

import {
  runMaterialize,
  runPrepare,
  runReserve,
  runService,
  runSync,
  runTeardown,
  resolveWorkspaceContext,
} from "./actor.ts";
import {
  Lifecycle,
  MaterializeInput,
  MaterializeOutput,
  PrepareInput,
  PrepareOutput,
  ReserveInput,
  ReserveOutput,
  ServiceInput,
  ServiceOutput,
  SyncInput,
  SyncOutput,
  TeardownInput,
  TeardownOutput,
  WORKSPACE_VERBS,
  type MaterializeOutput as MaterializeOutputT,
  type PrepareOutput as PrepareOutputT,
  type ReserveOutput as ReserveOutputT,
  type ServiceOutput as ServiceOutputT,
  type SyncOutput as SyncOutputT,
  type TeardownOutput as TeardownOutputT,
  type WorkspaceVerb,
} from "./schema.ts";
import { hydrate as hydrateBeads } from "../beads/hydrate.ts";
import { runKeeperRemoveWorktree } from "../pr-state/keeper.ts";
import {
  runWorktreeCreateHook,
  runWorktreeRemoveHook,
  type WorktreeHookResult,
} from "./worktree-hook.ts";

export type WorkspaceCliFormat = "plain" | "json";

export type WorkspaceCliArgs = {
  verb: WorkspaceVerb;
  format: WorkspaceCliFormat;
  // Common
  workspaceId?: string | undefined;
  // reserve
  branch?: string | undefined;
  base?: string | undefined;
  // prepare
  lifecycle?: string | undefined;
  // service
  action?: string | undefined;
  auto?: boolean | undefined;
  // teardown
  force?: boolean | undefined;
};

export class WorkspaceCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCliError";
  }
}

/**
 * Parse `prx workspace <verb> [flags]`. Returns a strongly-typed
 * `WorkspaceCliArgs`. Throws `WorkspaceCliError` on bad argv.
 */
export function parseWorkspaceArgs(argv: readonly string[]): WorkspaceCliArgs {
  if (argv.length === 0) {
    throw new WorkspaceCliError(
      `workspace requires a verb: ${WORKSPACE_VERBS.join(", ")}`,
    );
  }
  const verb = argv[0] ?? "";
  const rest = argv.slice(1);
  if (!(WORKSPACE_VERBS as readonly string[]).includes(verb)) {
    throw new WorkspaceCliError(
      `Unknown workspace verb: ${verb}. Expected: ${WORKSPACE_VERBS.join(", ")}`,
    );
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "plain" },
      "workspace-id": { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      lifecycle: { type: "string" },
      action: { type: "string" },
      auto: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const format = values.format === "json" ? "json" : "plain";
  return {
    verb: verb as WorkspaceVerb,
    format,
    workspaceId: values["workspace-id"],
    branch: values.branch,
    base: values.base,
    lifecycle: values.lifecycle,
    action: values.action,
    auto: values.auto ?? false,
    force: values.force ?? false,
  };
}

export type WorkspaceCliDeps = {
  cwd?: string;
  hydrateBeads?: (cwd: string) => boolean;
};

export type WorkspaceCliResult = {
  exitCode: number;
  output: string;
  payload:
    | ReserveOutputT
    | MaterializeOutputT
    | PrepareOutputT
    | SyncOutputT
    | ServiceOutputT
    | TeardownOutputT;
};

const SUCCESS_STATUSES = new Set<string>([
  "created",
  "exists",
  "exists-local",
  "exists-remote",
  "skipped",
  "ok",
  "noop",
  "started",
  "stopped",
  "no-profile",
  "torn-down",
]);

function resolveWorkspaceIdFromArgsOrCwd(
  cwd: string,
  workspaceIdArg: string | undefined,
  branch?: string | undefined,
): string | null {
  if (workspaceIdArg && /^[a-f0-9]{12}$/.test(workspaceIdArg)) {
    return workspaceIdArg;
  }
  const ctx = resolveWorkspaceContext({ cwd, ...(branch ? { branch } : {}) });
  return ctx?.workspaceId ?? null;
}

/**
 * Dispatch a parsed `WorkspaceCliArgs` to the actor and produce a
 * `WorkspaceCliResult`. Exit codes:
 *   - 0 on success-shaped statuses (see SUCCESS_STATUSES)
 *   - 1 on error / base-unresolved / parse failure
 */
export function runWorkspaceCli(
  args: WorkspaceCliArgs,
  deps: WorkspaceCliDeps = {},
): WorkspaceCliResult {
  const cwd = deps.cwd ?? process.cwd();

  if (args.verb === "reserve") {
    if (!args.branch) {
      throw new WorkspaceCliError("workspace reserve requires --branch <name>");
    }
    const input = ReserveInput.parse({
      branch: args.branch,
      ...(args.base !== undefined ? { base: args.base } : {}),
    });
    const out = runReserve(input, cwd);
    return finalize("reserve", out, args.format, ReserveOutput);
  }

  if (args.verb === "materialize") {
    const workspaceId = resolveWorkspaceIdFromArgsOrCwd(
      cwd,
      args.workspaceId,
      args.branch,
    );
    if (!workspaceId) {
      throw new WorkspaceCliError(
        "workspace materialize: cannot resolve workspace_id from cwd; pass --workspace-id",
      );
    }
    const input = MaterializeInput.parse({ workspace_id: workspaceId });
    const out = runMaterialize(input, cwd);
    return finalize("materialize", out, args.format, MaterializeOutput);
  }

  if (args.verb === "prepare") {
    if (!args.lifecycle) {
      throw new WorkspaceCliError(
        "workspace prepare requires --lifecycle {materialized|attached|running}",
      );
    }
    const lifecycle = Lifecycle.parse(args.lifecycle);
    const workspaceId = resolveWorkspaceIdFromArgsOrCwd(cwd, args.workspaceId);
    if (!workspaceId) {
      throw new WorkspaceCliError(
        "workspace prepare: cannot resolve workspace_id from cwd; pass --workspace-id",
      );
    }
    const input = PrepareInput.parse({
      workspace_id: workspaceId,
      lifecycle,
    });
    const hydrate = deps.hydrateBeads ?? defaultHydrateBeads;
    const out = runPrepare(input, cwd, { hydrateBeads: hydrate });
    return finalize("prepare", out, args.format, PrepareOutput);
  }

  if (args.verb === "sync") {
    const workspaceId = resolveWorkspaceIdFromArgsOrCwd(cwd, args.workspaceId);
    if (!workspaceId) {
      throw new WorkspaceCliError(
        "workspace sync: cannot resolve workspace_id from cwd; pass --workspace-id",
      );
    }
    const input = SyncInput.parse({ workspace_id: workspaceId });
    const out = runSync(input, cwd);
    return finalize("sync", out, args.format, SyncOutput);
  }

  if (args.verb === "service") {
    if (!args.action || (args.action !== "start" && args.action !== "stop")) {
      throw new WorkspaceCliError(
        "workspace service requires --action {start|stop}",
      );
    }
    const workspaceId = resolveWorkspaceIdFromArgsOrCwd(cwd, args.workspaceId);
    if (!workspaceId) {
      throw new WorkspaceCliError(
        "workspace service: cannot resolve workspace_id from cwd; pass --workspace-id",
      );
    }
    const input = ServiceInput.parse({
      workspace_id: workspaceId,
      action: args.action,
      auto: args.auto,
    });
    const out = runService(input, cwd);
    return finalize("service", out, args.format, ServiceOutput);
  }

  if (args.verb === "teardown") {
    const workspaceId = resolveWorkspaceIdFromArgsOrCwd(cwd, args.workspaceId);
    if (!workspaceId) {
      throw new WorkspaceCliError(
        "workspace teardown: cannot resolve workspace_id from cwd; pass --workspace-id",
      );
    }
    const input = TeardownInput.parse({
      workspace_id: workspaceId,
      force: args.force,
    });
    const out = runTeardown(input, cwd);
    return finalize("teardown", out, args.format, TeardownOutput);
  }

  throw new WorkspaceCliError(`Unhandled workspace verb: ${args.verb}`);
}

/** The Claude Code worktree-hook verbs, dispatched separately (they read the
 * hook envelope from stdin rather than flags — see {@link runWorktreeHookCli}). */
export const WORKTREE_HOOK_VERBS = ["worktree-create", "worktree-remove"] as const;
export type WorktreeHookVerb = (typeof WORKTREE_HOOK_VERBS)[number];

export function isWorktreeHookVerb(verb: string): verb is WorktreeHookVerb {
  return (WORKTREE_HOOK_VERBS as readonly string[]).includes(verb);
}

/** Injectable seam for {@link runWorktreeHookCli} (real engine by default). */
export type WorktreeHookCliDeps = {
  reserve?: typeof runReserve;
  materialize?: typeof runMaterialize;
  teardown?: typeof runTeardown;
  removeWorktree?: typeof runKeeperRemoveWorktree;
  resolveContext?: typeof resolveWorkspaceContext;
};

/**
 * Adapter from Claude Code's `WorktreeCreate`/`WorktreeRemove` hook envelope
 * (stdin JSON) to prx's worktree lifecycle — the slice that makes `claude
 * --worktree` materialize through prx in the bare-repo + external-worktree
 * layout. The boundary (parse / exit semantics) lives in `worktree-hook.ts`;
 * here we satisfy its two ports with the real engine:
 *
 *   create:  name → workspace.reserve → workspace.materialize (keeper does the
 *            `git worktree add`) → print the absolute path (Claude reads it as
 *            the session cwd; a non-zero exit aborts creation).
 *   remove:  worktree_path → keeper removes the git worktree (the git half) +
 *            workspace.teardown marks the ledger torn_down (the lifecycle half).
 *
 * The git/workspace split mirrors materialize: keeper owns the git ref/registry
 * mutation, the workspace actor owns the lifecycle ledger.
 */
export async function runWorktreeHookCli(
  verb: WorktreeHookVerb,
  stdin: string,
  cwd: string,
  deps: WorktreeHookCliDeps = {},
): Promise<WorktreeHookResult> {
  const reserve = deps.reserve ?? runReserve;
  const materialize = deps.materialize ?? runMaterialize;
  const teardown = deps.teardown ?? runTeardown;
  const removeWorktree = deps.removeWorktree ?? runKeeperRemoveWorktree;
  const resolveContext = deps.resolveContext ?? resolveWorkspaceContext;

  if (verb === "worktree-create") {
    return runWorktreeCreateHook({
      stdin,
      materialize: async (name) => {
        const reserved = reserve(ReserveInput.parse({ branch: name }), cwd);
        if (reserved.status === "error" || reserved.status === "base-unresolved") {
          throw new Error(
            reserved.error ?? `workspace.reserve failed for ${name} (${reserved.status})`,
          );
        }
        const mat = materialize(
          MaterializeInput.parse({ workspace_id: reserved.workspace_id }),
          cwd,
        );
        if (mat.status === "error") {
          throw new Error(mat.error ?? `workspace.materialize failed for ${name}`);
        }
        return mat.worktree_path;
      },
    });
  }

  return runWorktreeRemoveHook({
    stdin,
    teardown: async (worktreePath) => {
      // Resolve the ledger id while the worktree dir still exists, then remove
      // the git worktree (keeper) and mark the ledger torn_down (workspace).
      const ctx = resolveContext({ cwd: worktreePath });
      removeWorktree({ targetPath: worktreePath }, cwd);
      if (ctx) {
        teardown(TeardownInput.parse({ workspace_id: ctx.workspaceId, force: true }), cwd);
      }
    },
  });
}

function defaultHydrateBeads(cwd: string): boolean {
  const r = hydrateBeads({ cwd });
  return r.exitCode === 0 && (r.status === "hydrated" || r.status === "already-hydrated");
}

type AnyOutput =
  | ReserveOutputT
  | MaterializeOutputT
  | PrepareOutputT
  | SyncOutputT
  | ServiceOutputT
  | TeardownOutputT;

function finalize<T extends AnyOutput>(
  verb: WorkspaceVerb,
  out: T,
  format: WorkspaceCliFormat,
  schema: { parse: (v: unknown) => T },
): WorkspaceCliResult {
  const validated = schema.parse(out);
  const exitCode = SUCCESS_STATUSES.has(validated.status) ? 0 : 1;
  const output = format === "json"
    ? JSON.stringify(validated, null, 2)
    : formatPlain(verb, validated);
  return { exitCode, output, payload: validated };
}

function formatPlain(verb: WorkspaceVerb, out: AnyOutput): string {
  const lines = [
    `workspace.${verb}: ${out.status}`,
    `  workspace_id=${out.workspace_id}`,
  ];
  if ("branch_ref" in out) lines.push(`  branch_ref=${out.branch_ref}`);
  if ("branch" in out) lines.push(`  branch=${out.branch}`);
  if ("worktree_path" in out) lines.push(`  worktree_path=${out.worktree_path}`);
  if ("files_written" in out && out.files_written.length > 0) {
    lines.push(`  files_written=${out.files_written.join(",")}`);
  }
  if ("beads_hydrated" in out) {
    lines.push(`  beads_hydrated=${out.beads_hydrated}`);
  }
  if ("ignore_synced" in out) {
    lines.push(`  ignore_synced=${out.ignore_synced}`);
  }
  if ("tooling_drift_corrected" in out && out.tooling_drift_corrected.length > 0) {
    lines.push(`  drift=${out.tooling_drift_corrected.join(",")}`);
  }
  if ("profile" in out && out.profile) {
    lines.push(`  profile=${out.profile}`);
  }
  if ("compose_files" in out && out.compose_files.length > 0) {
    lines.push(`  compose_files=${out.compose_files.join(",")}`);
  }
  if ("cleaned" in out && out.cleaned.length > 0) {
    lines.push(`  cleaned=${out.cleaned.join(",")}`);
  }
  if (out.error) {
    lines.push(`  error=${out.error}`);
  }
  return lines.join("\n");
}
