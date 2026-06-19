/**
 * beadsd END-TO-END (GH-296): the REAL stack, no mocks.
 *
 * Stands up a real beads workspace (`bd init` in a temp dir), runs the real
 * {@link runBeadsServe} daemon over a real unix socket against the real `bd`
 * binary, and drives it with the real {@link IsolatedBeadsClient} through the
 * full read+write envelope. This is the automated answer to "does beads work
 * through beadsd?" — it would have caught the `close` dispatch bug (bd close is
 * policy-blocked; the canonical close is `update --status closed`).
 *
 * Skips when `bd`/`dolt` aren't on PATH (e.g. a minimal CI), so it never breaks
 * the build; runs for real wherever the beads toolchain exists.
 *
 * Writes are dispatched with the planner role — beadsd is the single writer and
 * runs as planner; the bd policy layer gates anything less (proven separately).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";

import { execBd as realExecBd, type BdExecOptions, type BdExecResult } from "@bounded-systems/bd";

import { runBeadsServe } from "../../src/beadsd/daemon.ts";
import { IsolatedBeadsClient } from "../../src/beadsd/client.ts";
import { unixSocketTransport } from "../../src/door/transport.ts";

const have = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const suite = have("bd") && have("dolt") ? describe : describe.skip;

suite("beadsd e2e — real daemon + real bd over a unix socket", () => {
  let dir: string;
  let server: Server | undefined;
  let client: IsolatedBeadsClient;
  let createdId = "";

  // Disable global/system gitconfig for every bd call: `bd init` runs `git
  // init` + `git commit`, and the host's global config (gpgsign + 1Password)
  // makes that commit HANG. Nulling the config makes the commit fail fast (no
  // identity) — bd warns and proceeds, which is all we need (cf. #272).
  const gitSafe = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  } as Record<string, string | undefined>;

  beforeAll(async () => {
    // Use /tmp explicitly, NOT os.tmpdir(): the test preload redirects TMPDIR
    // into the repo (`.tmp/bun-tests`), and bd's workspace discovery walks UP
    // the tree — a temp dir nested under the repo would resolve to the repo's
    // canonical .beads instead of this isolated one. /tmp has no .beads ancestor.
    dir = mkdtempSync("/tmp/beadsd-e2e-");
    // A real, self-contained beads workspace. bd resolves it from cwd (the daemon
    // runs every bd in cwd=dir, with BEADS_DIR cleared by execBd), so the test
    // stays off the canonical beads.
    spawnSync("bd", ["init", "--prefix", "e2e"], { cwd: dir, env: gitSafe, encoding: "utf8" });
    // beadsd runs as the single writer (planner role); inject that + the
    // git-safe env so the daemon's writes pass the bd gate and don't hang.
    const plannerExecBd = ((opts: BdExecOptions): BdExecResult =>
      realExecBd({ ...opts, role: "planner" }, gitSafe)) as typeof realExecBd;
    const sock = join(dir, "beadsd.sock");
    server = await runBeadsServe({ socketPath: sock, deps: { cwd: dir, execBd: plannerExecBd } });
    client = new IsolatedBeadsClient(unixSocketTransport(sock));
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (dir) {
      spawnSync("bd", ["dolt", "stop"], { cwd: dir, env: gitSafe });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create → an issue with an e2e- id", async () => {
    const res = await client.query({
      kind: "create",
      issueType: "task",
      title: "e2e task",
      priority: 2,
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const issue = res.result as { id: string; title: string };
      expect(issue.id).toMatch(/^e2e-/);
      expect(issue.title).toBe("e2e task");
      createdId = issue.id;
    }
  });

  test("show → the created issue", async () => {
    const res = await client.query({ kind: "show", id: createdId });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const rec = (Array.isArray(res.result) ? res.result[0] : res.result) as { id: string };
      expect(rec.id).toBe(createdId);
    }
  });

  test("ready → includes the open issue", async () => {
    const res = await client.query({ kind: "ready" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const ids = (res.result as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(createdId);
    }
  });

  test("update → status change succeeds", async () => {
    const res = await client.query({ kind: "update", id: createdId, status: "in_progress" });
    expect(res.status).toBe("ok");
  });

  test("close → succeeds (via update --status closed) and drops out of ready", async () => {
    const res = await client.query({ kind: "close", id: createdId, reason: "e2e done" });
    expect(res.status).toBe("ok");
    const ready = await client.query({ kind: "ready" });
    expect(ready.status).toBe("ok");
    if (ready.status === "ok") {
      const ids = (ready.result as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(createdId);
    }
  });

  test("list --status closed → includes the closed issue", async () => {
    const res = await client.query({ kind: "list", status: "closed" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const ids = (res.result as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(createdId);
    }
  });
});
