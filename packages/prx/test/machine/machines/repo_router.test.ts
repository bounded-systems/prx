// GH-1659 — repoRouterMachine transition tests.
//
// Drives the per-tick cross-repo routing lifecycle
// (idle → resolving → materializing → routed → completed) and the two
// terminal failure arms (missing-pin and failed-materialize) so the
// context-projection actions are pinned independently of the
// orchestrator's I/O. Pattern: `test/machine/machines/fetch.test.ts`.

import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import {
  repoRouterMachine,
  type RepoRouterContext,
} from "../../../src/machine/machines/repo_router.ts";

function startMachine() {
  const actor = createActor(repoRouterMachine);
  actor.start();
  return actor;
}

function snapshot(actor: ReturnType<typeof startMachine>): {
  value: unknown;
  context: RepoRouterContext;
} {
  const snap = actor.getSnapshot();
  return { value: snap.value, context: snap.context };
}

describe("repoRouterMachine — happy path", () => {
  test("idle → resolving → materializing → routed → completed", () => {
    const actor = startMachine();
    expect(snapshot(actor).value).toBe("idle");

    actor.send({
      type: "BD_PREFIX_DETECTED",
      surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
      prefix: "demo-repo",
    });
    expect(snapshot(actor).value).toBe("resolving");
    expect(snapshot(actor).context.prefix).toBe("demo-repo");
    expect(snapshot(actor).context.surfaceId).toBe("BD-demo-repo-1777747201085-737-407f177f");

    actor.send({
      type: "REPO_PIN_RESOLVED",
      prefix: "demo-repo",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
    });
    expect(snapshot(actor).value).toBe("materializing");
    expect(snapshot(actor).context.repo).toBe("demo-repo");
    expect(snapshot(actor).context.barePath).toBe("/tmp/bare/demo-repo.git");

    actor.send({
      type: "BARE_MATERIALIZED",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
      action: "cloned",
    });
    expect(snapshot(actor).value).toBe("routed");
    expect(snapshot(actor).context.action).toBe("cloned");

    actor.send({
      type: "SESSION_RE_DISPATCHED",
      surfaceId: "BD-demo-repo-1777747201085-737-407f177f",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
    });
    expect(snapshot(actor).value).toBe("completed");
  });
});

describe("repoRouterMachine — missing-pin terminal", () => {
  test("idle → resolving → failed_mid_route via ROUTE_REFUSED_NO_PIN", () => {
    const actor = startMachine();
    const surfaceId = "BD-unknown-prefix-1777747201085-1-deadbeef";
    actor.send({
      type: "BD_PREFIX_DETECTED",
      surfaceId,
      prefix: "unknown-prefix",
    });
    expect(snapshot(actor).value).toBe("resolving");

    actor.send({
      type: "ROUTE_REFUSED_NO_PIN",
      surfaceId,
      prefix: "unknown-prefix",
      hint: 'error: bd workspace prefix "unknown-prefix" is not pinned',
    });
    expect(snapshot(actor).value).toBe("failed_mid_route");
    expect(snapshot(actor).context.reason).toBe(
      'error: bd workspace prefix "unknown-prefix" is not pinned',
    );
    expect(snapshot(actor).context.prefix).toBe("unknown-prefix");
  });
});

describe("repoRouterMachine — failed-materialize terminal", () => {
  test("idle → resolving → materializing → failed_mid_route via ROUTE_FAILED", () => {
    const actor = startMachine();
    const surfaceId = "BD-demo-repo-1777747201085-737-407f177f";
    actor.send({
      type: "BD_PREFIX_DETECTED",
      surfaceId,
      prefix: "demo-repo",
    });
    actor.send({
      type: "REPO_PIN_RESOLVED",
      prefix: "demo-repo",
      repo: "demo-repo",
      barePath: "/tmp/bare/demo-repo.git",
    });
    expect(snapshot(actor).value).toBe("materializing");

    actor.send({
      type: "ROUTE_FAILED",
      surfaceId,
      reason: "git clone --bare failed: exit 128",
    });
    expect(snapshot(actor).value).toBe("failed_mid_route");
    expect(snapshot(actor).context.reason).toBe("git clone --bare failed: exit 128");
    // Pin from the resolve step must survive the failure.
    expect(snapshot(actor).context.repo).toBe("demo-repo");
  });
});
