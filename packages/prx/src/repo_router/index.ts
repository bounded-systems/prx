// GH-1659 — `repo_router` orchestrator + pure `decideRoute` helper.
// ADR: docs/spikes/GH-1646-cross-repo-bd-routing.md §5.
//
// Library-only seam. The orchestrator drives `repoRouterMachine`
// (src/machine/machines/repo_router.ts), emits parity-chain audit rows
// through `recordEvent`, and exposes the six injectable deps the unit
// tests pin. CLI wiring (`prx plan session --repo …`, OPEN_PLAN_SESSION
// re-dispatch) lands in GH-1661; the materialize verb lands in GH-1660.
// Both are stubbed here via the `materializeRepo` / `redispatchOpenPlanSession`
// deps so this PR is mergeable independent of either.

import { createActor } from "xstate";

import { recordEvent as defaultRecordEvent } from "../machine/record_event.ts";
import {
  repoRouterMachine,
  type RepoRouterMaterializeAction,
} from "../machine/machines/repo_router.ts";
import {
  loadRepoInventoryConfig as defaultLoadRepoInventoryConfig,
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  localWorkspacePrefixForCwd as defaultLocalWorkspacePrefixForCwd,
  type LocalRepo,
  type RepoInventory,
} from "../pr-state/repos.ts";

/**
 * GH-1658-side `BD-<prefix>-<ts>-<seq>-<hex8>` long-id surface form.
 * Mirrors the regex in `BdDomainAdapter` (`BD_SURFACE_LONG_ID_RE`) so
 * the router parses the same surface space the adapter does. Captures
 * `(prefix, tail)`; prefix is the lowercase workspace slug.
 *
 * GH-1806: exported so `prx submit postmerge` can run the same parse
 * against PR-body refs before classifying through `decideRoute` — a
 * narrowed per-repo identity overlay must not be able to hide a
 * foreign-prefix long-id from the cross-workspace skip diagnostic.
 */
export const BD_SURFACE_LONG_ID_RE = /^BD-([a-z][a-z0-9-]*)-(\d{13,}-\d+-[0-9a-f]{8})$/;

export type RouteDecision =
  | { kind: "unrecognized" }
  | { kind: "local"; prefix: string }
  | { kind: "foreign"; prefix: string; repo: LocalRepo; barePath: string }
  | { kind: "missing-pin"; prefix: string };

/**
 * ADR §6 — operator-facing structured hint for the missing-pin terminal
 * arm. Copy-pasted byte-for-byte from the ADR so the operator sees the
 * same payload the design doc promised.
 */
export function missingPinHint(prefix: string): string {
  return (
    `error: bd workspace prefix "${prefix}" is not pinned in\n` +
    `.prx/repos/index.json. To enable cross-repo routing:\n` +
    `  prx repo add <path-or-url>            # discovers + pins the prefix\n` +
    `  prx repo add --bd-workspace-prefix ${prefix} <path-or-url>\n` +
    `                                        # explicit override`
  );
}

/**
 * GH-1661 ADR §6 conflict rule — operator-facing hint when an explicit
 * `--repo X` disagrees with an embedded BD prefix that resolves to a
 * different repo Y. Names both repos and the embedded prefix so the
 * operator can decide which override is correct.
 */
export function conflictHint(
  requestedRepo: string,
  embeddedPrefix: string,
  embeddedRepo: string,
): string {
  return (
    `error: --repo ${requestedRepo} conflicts with the bd workspace prefix\n` +
    `"${embeddedPrefix}" embedded in the surface id, which is pinned to\n` +
    `repo "${embeddedRepo}" in .prx/repos/index.json. Drop --repo to route\n` +
    `to "${embeddedRepo}", or correct the surface id if "${requestedRepo}"\n` +
    `is the intended target.`
  );
}

/**
 * Pure routing decision. Parses the surface id (long-id arm only),
 * matches the embedded prefix against (a) the local cwd's prefix and
 * (b) the index inventory, and returns a discriminated union encoding
 * ADR §4's three terminal arms plus a fourth `unrecognized` arm for
 * surface ids that are not BD long-ids.
 */
export function decideRoute(
  surfaceId: string,
  inventory: RepoInventory | null,
  localPrefix: string | null,
): RouteDecision {
  const trimmed = surfaceId.trim();
  const match = trimmed.match(BD_SURFACE_LONG_ID_RE);
  if (!match) {
    return { kind: "unrecognized" };
  }
  const prefix = match[1]!;

  if (localPrefix !== null && prefix === localPrefix) {
    return { kind: "local", prefix };
  }

  if (inventory) {
    for (const repo of inventory.repos) {
      if (repo.bd_workspace_prefix === prefix) {
        return { kind: "foreign", prefix, repo, barePath: repo.commonDir };
      }
    }
  }

  return { kind: "missing-pin", prefix };
}

export type RunRepoRouterArgs = {
  surfaceId: string;
  cwd: string;
  /** I-RR5: dry-run emits the event chain without invoking the deps. */
  dryRun?: boolean | undefined;
  /**
   * GH-1661: explicit `--repo <name>` override from the CLI. When set,
   * the router cross-checks against the embedded BD prefix and refuses
   * with `ROUTE_REFUSED_CONFLICT` if the two disagree. Local-arm matches
   * pass through; missing-pin still wins; unrecognized surface ids
   * ignore the override (caller threads it to `resolveUoW` directly).
   */
  repoOverride?: string | undefined;
};

export type RunRepoRouterDeps = {
  loadRepoInventoryConfig?: typeof defaultLoadRepoInventoryConfig;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  localWorkspacePrefixForCwd?: typeof defaultLocalWorkspacePrefixForCwd;
  /**
   * GH-1660 (#1676) wires this dep to `prx repo materialize <name>`. The
   * library default is `null`; the foreign arm refuses if it is missing
   * (caller must supply). The test harness stubs it.
   */
  materializeRepo?: (
    repo: LocalRepo,
    opts: { dryRun: boolean },
  ) => { action: RepoRouterMaterializeAction; barePath: string };
  /**
   * GH-1661 wires this dep to a real OPEN_PLAN_SESSION re-dispatch
   * against the foreign bare. The library default is `null`; the audit
   * event still fires regardless. See plan §7.1 for the documentary
   * disposition.
   */
  redispatchOpenPlanSession?: (input: {
    surfaceId: string;
    repo: string;
    barePath: string;
  }) => void;
  recordEvent?: typeof defaultRecordEvent;
};

export type RunRepoRouterResult =
  | { status: "unrecognized" }
  | { status: "local"; prefix: string }
  | {
      status: "routed";
      repo: string;
      barePath: string;
      action: RepoRouterMaterializeAction;
    }
  | { status: "refused-no-pin"; prefix: string; hint: string }
  | {
      // GH-1661: explicit --repo override disagrees with the embedded
      // prefix's pinned repo.
      status: "refused-conflict";
      requestedRepo: string;
      embeddedPrefix: string;
      embeddedRepo: string;
      hint: string;
    }
  | { status: "failed"; reason: string };

/**
 * Drive the `repoRouterMachine` end-to-end for one surface id. Reads
 * the inventory once at entry (I-RR2), parses + classifies the
 * surface id via `decideRoute`, and walks the lifecycle to a terminal
 * state. Emits the six ADR §5 events through `recordEvent` AND
 * `actor.send` so both the parity chain and the machine context
 * advance.
 *
 * Local / unrecognized arms short-circuit *before* instantiating the
 * machine — those routes never enter the lifecycle, so the caller
 * sees no `BD_PREFIX_DETECTED` audit row (consistent with §3, no
 * "documentary" event for non-routing cases).
 */
export function runRepoRouter(
  args: RunRepoRouterArgs,
  deps: RunRepoRouterDeps = {},
): RunRepoRouterResult {
  const loadConfig = deps.loadRepoInventoryConfig ?? defaultLoadRepoInventoryConfig;
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const localPrefixFor = deps.localWorkspacePrefixForCwd ?? defaultLocalWorkspacePrefixForCwd;
  const recordEvent = deps.recordEvent ?? defaultRecordEvent;

  // I-RR2: read inventory once, pin for the lifetime of the tick.
  const config = loadConfig(args.cwd);
  const inventory = config.indexPath ? loadIndex(config.indexPath) : null;
  const localPrefix = localPrefixFor(args.cwd);

  const decision = decideRoute(args.surfaceId, inventory, localPrefix);

  if (decision.kind === "unrecognized") {
    // GH-1661: the surface id is not a BD long-id, so there is no
    // embedded prefix to conflict with. The caller threads
    // `repoOverride` to `resolveUoW` directly.
    return { status: "unrecognized" };
  }

  // GH-1661: explicit --repo cross-check. For local arm, the implicit
  // "repo" is the cwd's own repo; we need to resolve its name from
  // inventory to compare. For foreign arm, decision.repo.name is direct.
  if (decision.kind === "local") {
    if (args.repoOverride !== undefined) {
      const localRepoName =
        inventory && localPrefix
          ? (inventory.repos.find((r) => r.bd_workspace_prefix === localPrefix)?.name ?? null)
          : null;
      if (localRepoName !== null && args.repoOverride !== localRepoName) {
        const hint = conflictHint(args.repoOverride, decision.prefix, localRepoName);
        const actor = createActor(repoRouterMachine);
        actor.start();
        recordEvent("BD_PREFIX_DETECTED", {
          details: { surfaceId: args.surfaceId, prefix: decision.prefix },
        });
        actor.send({
          type: "BD_PREFIX_DETECTED",
          surfaceId: args.surfaceId,
          prefix: decision.prefix,
        });
        recordEvent("ROUTE_REFUSED_CONFLICT", {
          details: {
            surfaceId: args.surfaceId,
            requestedRepo: args.repoOverride,
            embeddedPrefix: decision.prefix,
            embeddedRepo: localRepoName,
            hint,
          },
        });
        actor.send({
          type: "ROUTE_REFUSED_CONFLICT",
          surfaceId: args.surfaceId,
          requestedRepo: args.repoOverride,
          embeddedPrefix: decision.prefix,
          embeddedRepo: localRepoName,
          hint,
        });
        return {
          status: "refused-conflict",
          requestedRepo: args.repoOverride,
          embeddedPrefix: decision.prefix,
          embeddedRepo: localRepoName,
          hint,
        };
      }
    }
    return { status: "local", prefix: decision.prefix };
  }

  const actor = createActor(repoRouterMachine);
  actor.start();

  recordEvent("BD_PREFIX_DETECTED", {
    details: { surfaceId: args.surfaceId, prefix: decision.prefix },
  });
  actor.send({
    type: "BD_PREFIX_DETECTED",
    surfaceId: args.surfaceId,
    prefix: decision.prefix,
  });

  if (decision.kind === "missing-pin") {
    // GH-1661: missing-pin wins over `repoOverride` — the override
    // can't conjure an inventory entry. The hint still asks the
    // operator to pin the prefix.
    const hint = missingPinHint(decision.prefix);
    recordEvent("ROUTE_REFUSED_NO_PIN", {
      details: { surfaceId: args.surfaceId, prefix: decision.prefix, hint },
    });
    actor.send({
      type: "ROUTE_REFUSED_NO_PIN",
      surfaceId: args.surfaceId,
      prefix: decision.prefix,
      hint,
    });
    return { status: "refused-no-pin", prefix: decision.prefix, hint };
  }

  // Foreign arm — REPO_PIN_RESOLVED, then materialize, then re-dispatch.
  const { repo, barePath: predictedBarePath } = decision;
  const repoName = repo.name;

  // GH-1661: foreign-arm conflict check. If --repo X disagrees with the
  // embedded prefix's pinned repo Y, refuse at the gate before
  // materializing anything.
  if (args.repoOverride !== undefined && args.repoOverride !== repoName) {
    const hint = conflictHint(args.repoOverride, decision.prefix, repoName);
    recordEvent("ROUTE_REFUSED_CONFLICT", {
      details: {
        surfaceId: args.surfaceId,
        requestedRepo: args.repoOverride,
        embeddedPrefix: decision.prefix,
        embeddedRepo: repoName,
        hint,
      },
    });
    actor.send({
      type: "ROUTE_REFUSED_CONFLICT",
      surfaceId: args.surfaceId,
      requestedRepo: args.repoOverride,
      embeddedPrefix: decision.prefix,
      embeddedRepo: repoName,
      hint,
    });
    return {
      status: "refused-conflict",
      requestedRepo: args.repoOverride,
      embeddedPrefix: decision.prefix,
      embeddedRepo: repoName,
      hint,
    };
  }
  recordEvent("REPO_PIN_RESOLVED", {
    details: { prefix: decision.prefix, repo: repoName, barePath: predictedBarePath },
  });
  actor.send({
    type: "REPO_PIN_RESOLVED",
    prefix: decision.prefix,
    repo: repoName,
    barePath: predictedBarePath,
  });

  if (args.dryRun) {
    // I-RR5: dry-run emits the full event chain without calling the
    // materialize / redispatch deps. `action: "noop"` is the literal
    // marker for "would have materialized" so the audit log makes the
    // dry-run shape explicit.
    recordEvent("BARE_MATERIALIZED", {
      details: { repo: repoName, barePath: predictedBarePath, action: "noop" },
    });
    actor.send({
      type: "BARE_MATERIALIZED",
      repo: repoName,
      barePath: predictedBarePath,
      action: "noop",
    });
    recordEvent("SESSION_RE_DISPATCHED", {
      details: { surfaceId: args.surfaceId, repo: repoName, barePath: predictedBarePath },
    });
    actor.send({
      type: "SESSION_RE_DISPATCHED",
      surfaceId: args.surfaceId,
      repo: repoName,
      barePath: predictedBarePath,
    });
    return {
      status: "routed",
      repo: repoName,
      barePath: predictedBarePath,
      action: "noop",
    };
  }

  const materialize = deps.materializeRepo;
  if (!materialize) {
    const reason =
      "repo_router: no materializeRepo dep supplied; cross-repo routing requires GH-1660 (`prx repo materialize`) wiring";
    recordEvent("ROUTE_FAILED", {
      details: { surfaceId: args.surfaceId, reason },
    });
    actor.send({ type: "ROUTE_FAILED", surfaceId: args.surfaceId, reason });
    return { status: "failed", reason };
  }

  let action: RepoRouterMaterializeAction;
  let resolvedBarePath: string;
  try {
    const result = materialize(repo, { dryRun: false });
    action = result.action;
    resolvedBarePath = result.barePath;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    recordEvent("ROUTE_FAILED", {
      details: { surfaceId: args.surfaceId, reason },
    });
    actor.send({ type: "ROUTE_FAILED", surfaceId: args.surfaceId, reason });
    return { status: "failed", reason };
  }

  recordEvent("BARE_MATERIALIZED", {
    details: { repo: repoName, barePath: resolvedBarePath, action },
  });
  actor.send({
    type: "BARE_MATERIALIZED",
    repo: repoName,
    barePath: resolvedBarePath,
    action,
  });

  if (deps.redispatchOpenPlanSession) {
    deps.redispatchOpenPlanSession({
      surfaceId: args.surfaceId,
      repo: repoName,
      barePath: resolvedBarePath,
    });
  }

  recordEvent("SESSION_RE_DISPATCHED", {
    details: { surfaceId: args.surfaceId, repo: repoName, barePath: resolvedBarePath },
  });
  actor.send({
    type: "SESSION_RE_DISPATCHED",
    surfaceId: args.surfaceId,
    repo: repoName,
    barePath: resolvedBarePath,
  });

  return {
    status: "routed",
    repo: repoName,
    barePath: resolvedBarePath,
    action,
  };
}
