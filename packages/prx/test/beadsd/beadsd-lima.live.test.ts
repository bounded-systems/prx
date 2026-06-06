/**
 * beadsd VM LIVE e2e (GH-296) — opt-in, exercises the real host→VM path.
 *
 * The local e2e (beadsd.e2e.test.ts) proves daemon↔client↔bd on one host. This
 * proves the full isolated-VM deployment: provision beads in a real Lima VM,
 * start beadsd there, and query it from the host over the Lima-SSH channel —
 * real data, every layer.
 *
 * Opt-in (skipped in CI / without a VM):
 *   PRX_BEADSD_LIVE_VM       Lima instance name (required to run)
 *   PRX_BEADSD_LIVE_ORIGIN   repo origin slug (default bounded-systems/prx)
 *   PRX_BEADSD_LIVE_BINARY   host Linux prx (default dist/prx-linux-arm64)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { provisionVmBeads } from "../../src/beadsd/provision.ts";
import { provisionBeadsd, stopBeadsd, withLimaBeadsClient } from "../../src/beadsd/lima.ts";

const TMP_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

const LIVE_VM = process.env.PRX_BEADSD_LIVE_VM;
const LIVE_ORIGIN = process.env.PRX_BEADSD_LIVE_ORIGIN ?? "bounded-systems/prx";
const LIVE_BIN = process.env.PRX_BEADSD_LIVE_BINARY ?? "dist/prx-linux-arm64";

const live = LIVE_VM ? describe : describe.skip;

live("beadsd VM lifecycle — LIVE (opt-in via PRX_BEADSD_LIVE_*)", () => {
  const vm = LIVE_VM!;
  const savedTmp: Record<string, string | undefined> = {};

  beforeAll(() => {
    // The Lima channel opens SSH `-L` + ControlMaster sockets under os.tmpdir();
    // the unix-socket path limit is ~104 bytes, but the test preload redirects
    // tmpdir() under the deep repo path. Use a short tmp for the duration of this
    // (opt-in) live test only — scoped to beforeAll/afterAll so it never leaks
    // into the rest of the suite (production tmpdir() is /tmp, already short).
    for (const k of TMP_KEYS) {
      savedTmp[k] = process.env[k];
      process.env[k] = "/tmp";
    }
  });

  afterAll(async () => {
    for (const k of TMP_KEYS) {
      if (savedTmp[k] === undefined) delete process.env[k];
      else process.env[k] = savedTmp[k];
    }
    await stopBeadsd({ vm });
  });

  test("provision → up → query over the Lima channel returns real data", async () => {
    // 1. Stand up the beads source in the VM (install bd+dolt, clone canonical).
    const prov = provisionVmBeads({ vm, originSlug: LIVE_ORIGIN });
    expect(prov.database).toMatch(/^io_github_/);

    // 2. Start beadsd in the VM, bound to that workspace.
    const handle = await provisionBeadsd({ vm, binaryPath: LIVE_BIN, cwd: prov.workspace });
    expect(handle.socket).toBe("/tmp/beadsd.sock");

    // 3. Query it from the host over the forwarded socket — the full path.
    // An explicit SHORT host socket: the unix-socket path limit (~104 chars) is
    // tight, and the test preload redirects tmpdir() under the deep repo path.
    const hostSocket = `/tmp/bd-live-${process.pid}.sock`;
    const ready = await withLimaBeadsClient({ vm, vmSocket: handle.socket, hostSocket }, (c) =>
      c.query({ kind: "ready" }),
    );
    expect(ready.status).toBe("ok");

    const closed = await withLimaBeadsClient({ vm, vmSocket: handle.socket, hostSocket }, (c) =>
      c.query({ kind: "list", status: "closed" }),
    );
    expect(closed.status).toBe("ok");
    if (closed.status === "ok") {
      // The canonical beads has at least one closed issue (e.g. prx-abb).
      expect(Array.isArray(closed.result)).toBe(true);
      expect((closed.result as unknown[]).length).toBeGreaterThan(0);
    }
  }, 180_000);
});
