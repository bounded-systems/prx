import { createActor } from "xstate";

import {
  sessionEntryMachine,
  type SessionEntryEvent,
} from "../../machine/machines/session-entry.ts";
import type { RuntimeProfileProjection } from "../../machine/runtime_profiles.ts";
import { PRX_SESSION_CONTEXT_ENV } from "./get-current-session-context.ts";
import { eventForArgv } from "./event-for-argv.ts";
import { appendAuditRow, makeAuditInspector } from "../../audit/sink.ts";
import { migrateLegacyNotionCache } from "../../tools/cache_path.ts";
import {
  runRepoRouter as defaultRunRepoRouter,
  type RunRepoRouterDeps,
  type RunRepoRouterResult,
} from "../../repo_router/index.ts";
import { materializeBareRepo, type MaterializeResult } from "../materialize.ts";
import type { LocalRepo } from "../repos.ts";
import type { RepoRouterMaterializeAction } from "../../machine/machines/repo_router.ts";

/**
 * GH-977: drive `sessionEntryMachine` to a final state and return the
 * runtime-profile projection it built, with `PRX_SESSION_CONTEXT` injected
 * into the projection's env so child `prx` invocations launched from inside
 * the session can read the active context via `getCurrentSessionContext()`.
 *
 * Per machine design, `idle` transitions to a `final` state on every
 * supported event and the chosen `bootClaude*` action populates
 * `context.profile`. A missing profile would mean the machine was wired with
 * an unsupported event — surfacing it as an error keeps the contract honest.
 */
/**
 * GH-977: argv variant of `dispatchSessionEntryEvent`. Uses `eventForArgv`
 * as the canonical argv→event mapper, making it the production reference for
 * the alias rule (intake/triage sites, scripts, and test utilities that have
 * raw argv rather than already-parsed flags).
 *
 * GH-1661: when `routingDeps` are supplied AND the parsed event is
 * `OPEN_PLAN_SESSION` without an embedded recursion guard
 * (`repoCtx.cwd`), the router runs first to handle implicit cross-repo
 * routing, conflict refusals, and missing-pin refusals. The legacy
 * intake/triage callers pass no `routingDeps`, so their behavior is
 * unchanged (the router would short-circuit on `unrecognized` anyway —
 * their argv is not a BD long-id).
 */
export function dispatchFromArgv(argv: readonly string[]): RuntimeProfileProjection {
  const event = eventForArgv(argv);
  if (!event) {
    throw new Error(`session-entry: no SessionEntryEvent matched argv: ${argv.join(" ")}`);
  }
  return dispatchSessionEntryEvent(event);
}

/**
 * GH-1661: argv → routing-aware dispatch. Returns a typed union so the
 * caller can render the operator-facing hint and pick the exit code.
 *
 * - `kind: "profile"` — the router cleared (local / unrecognized) and
 *   the session-entry machine built the runtime profile normally.
 * - `kind: "routed"` — the router materialized a foreign bare and the
 *   redispatch dep returned a profile (or the redispatch dep was
 *   stubbed; the caller decides what to do with the result).
 * - `kind: "refused"` — typed terminal refusal from the router. The
 *   `hint` carries the operator-facing message; the caller prints it
 *   to stderr and exits non-zero.
 * - `kind: "failed"` — the router invoked materialize and it threw.
 *
 * The recursion guard is `event.repoCtx.cwd`: when set, this is a
 * re-dispatch from the router and the routing step is skipped.
 */
export type DispatchFromArgvResult =
  | { kind: "profile"; profile: RuntimeProfileProjection }
  | { kind: "routed"; profile: RuntimeProfileProjection; repo: string; barePath: string }
  | { kind: "refused"; reason: "no-pin" | "conflict"; hint: string }
  | { kind: "failed"; reason: string };

export type DispatchFromArgvRoutingDeps = {
  cwd?: () => string;
  runRepoRouter?: typeof defaultRunRepoRouter;
  routerDeps?: RunRepoRouterDeps;
  /**
   * Production materialize seam. Defaults to {@link materializeBareRepo}
   * wrapped to the `RunRepoRouterDeps.materializeRepo` shape. Tests
   * stub via `routerDeps.materializeRepo` instead.
   */
  materializeRepo?: (
    repo: LocalRepo,
    opts: { dryRun: boolean },
  ) => { action: RepoRouterMaterializeAction; barePath: string };
};

export function dispatchFromArgvWithRouting(
  argv: readonly string[],
  deps: DispatchFromArgvRoutingDeps = {},
): DispatchFromArgvResult {
  const event = eventForArgv(argv);
  if (!event) {
    throw new Error(`session-entry: no SessionEntryEvent matched argv: ${argv.join(" ")}`);
  }

  // Recursion guard: when `repoCtx.cwd` is set, this is a re-dispatch
  // from the router — skip routing and dispatch the event as-is.
  if (event.type !== "OPEN_PLAN_SESSION" || event.repoCtx?.cwd !== undefined) {
    return { kind: "profile", profile: dispatchSessionEntryEvent(event) };
  }

  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const runRouter = deps.runRepoRouter ?? defaultRunRepoRouter;
  const materialize = deps.materializeRepo ?? defaultMaterializeForRouter;

  let redispatchedProfile: RuntimeProfileProjection | null = null;
  const routerDeps: RunRepoRouterDeps = {
    materializeRepo: materialize,
    ...deps.routerDeps,
    redispatchOpenPlanSession: ({ repo, barePath }) => {
      // Recursive call with the recursion guard set. The router will
      // skip routing on this hop and the session-entry machine will
      // build the runtime profile against the foreign bare.
      redispatchedProfile = dispatchSessionEntryEvent({
        ...event,
        repoCtx: { repo, cwd: barePath },
      });
    },
  };

  const result: RunRepoRouterResult = runRouter(
    {
      surfaceId: event.workUnitId,
      cwd,
      repoOverride: event.repoCtx?.repo,
    },
    routerDeps,
  );

  switch (result.status) {
    case "unrecognized":
    case "local":
      return { kind: "profile", profile: dispatchSessionEntryEvent(event) };
    case "refused-no-pin":
      return { kind: "refused", reason: "no-pin", hint: result.hint };
    case "refused-conflict":
      return { kind: "refused", reason: "conflict", hint: result.hint };
    case "failed":
      return { kind: "failed", reason: result.reason };
    case "routed":
      if (redispatchedProfile === null) {
        // No redispatchOpenPlanSession dep ran (or the dep was
        // overridden in routerDeps without re-invoking dispatch).
        // Fall back to the original event so the caller still gets a
        // profile — matches the existing GH-1659 dep stub posture.
        return {
          kind: "routed",
          profile: dispatchSessionEntryEvent(event),
          repo: result.repo,
          barePath: result.barePath,
        };
      }
      return {
        kind: "routed",
        profile: redispatchedProfile,
        repo: result.repo,
        barePath: result.barePath,
      };
  }
}

/**
 * Adapt {@link materializeBareRepo} (the GH-1660 verb) to the
 * `RunRepoRouterDeps.materializeRepo` shape. The router only consumes
 * `action` + `barePath`; the verb returns a richer
 * {@link MaterializeResult}.
 */
function defaultMaterializeForRouter(
  repo: LocalRepo,
  opts: { dryRun: boolean },
): { action: RepoRouterMaterializeAction; barePath: string } {
  const result: MaterializeResult = materializeBareRepo({
    name: repo.name,
    dryRun: opts.dryRun,
  });
  return { action: result.action, barePath: result.barePath };
}

export function dispatchSessionEntryEvent(event: SessionEntryEvent): RuntimeProfileProjection {
  // GH-867: best-effort one-shot migration of legacy `.prx/notion-cache/`
  // into the XDG cache root. Idempotent — second invocation no-ops because
  // the legacy dir has been removed. Failures here are swallowed so a corrupt
  // legacy file cannot block session entry.
  try {
    migrateLegacyNotionCache({ repoRoot: process.cwd() });
  } catch {
    // intentionally ignored — operator state is regenerable
  }

  // GH-1403: emit machine state-transition rows for the one-shot
  // sessionEntryMachine. Pulls workUnitId off the event when present so the
  // emitted rows are scope-bound.
  const workUnitId =
    "workUnitId" in event && typeof event.workUnitId === "string" ? event.workUnitId : undefined;
  const actor = createActor(sessionEntryMachine, {
    inspect: makeAuditInspector("session-entry", { workUnitId }),
  }).start();
  actor.send(event);
  const snap = actor.getSnapshot();
  const profile = snap.context.profile;
  if (!profile) {
    throw new Error(`session-entry: machine returned no profile for event ${event.type}`);
  }

  // GH-1403: synthetic dispatch row. The state-entry rows from the inspector
  // capture the machine transition; this row records the resolved profile
  // (and therefore which `bootClaude*` action ran).
  try {
    appendAuditRow({
      ts: new Date().toISOString(),
      machine: "session-entry",
      kind: "dispatch",
      ...(workUnitId ? { workUnitId } : {}),
      state: String(snap.value),
      event: event.type,
      profile: profile.profile ?? "unknown",
      actor: "claude-code",
    });
  } catch {
    // sink-side errors are intentionally swallowed (parity with inspector)
  }

  return {
    ...profile,
    env: {
      ...(profile.env ?? {}),
      [PRX_SESSION_CONTEXT_ENV]: String(snap.value),
    },
  };
}
