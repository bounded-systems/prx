import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { issuerKeys, mintDoorGrant } from "../../src/door/grant-issuer.ts";
import { runForgeDServe, type ForgeDServer } from "../../src/forge-d/daemon.ts";

const AUDIENCE = "claude-room";

type Resp = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

/** Minimal newline-JSON client (TCP or unix) — the wire createDoorHandlers speaks. */
function send(target: { port: number } | { path: string }, req: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const opts =
      "port" in target ? { host: "127.0.0.1", port: target.port } : { path: target.path };
    const c = connect(opts, () => c.write(JSON.stringify(req) + "\n"));
    let buf = "";
    c.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i !== -1) {
        try {
          resolve(JSON.parse(buf.slice(0, i)) as Resp);
        } catch (e) {
          reject(e);
        }
        c.end();
      }
    });
    c.on("error", reject);
  });
}

const leaseReq = (grant?: unknown) => ({
  id: "1",
  method: "lease",
  params: {},
  ...(grant ? { grant } : {}),
});

describe("runForgeDServe TCP grant gate (prx-8uf2)", () => {
  let server: ForgeDServer | undefined;
  let unixPath: string | undefined;
  let counter = 0;
  const port = () => 42000 + (process.pid % 2000) + counter++;
  // forge-d holds no key here — the gate runs BEFORE dispatch, so a gated request
  // is rejected before it ever reaches the (unconfigured) lease handler.

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (unixPath) rmSync(unixPath, { force: true });
    unixPath = undefined;
  });

  test("TCP + gate: a lease with NO grant is denied before dispatch", async () => {
    const p = port();
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
    });
    const res = await send({ port: p }, leaseReq());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNAUTHENTICATED");
  });

  test("TCP + gate: a grant minted for a DIFFERENT door is denied", async () => {
    const p = port();
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
    });
    const grant = mintDoorGrant({
      door: "keeper",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n",
      now: Date.now(),
    });
    const res = await send({ port: p }, leaseReq(grant));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNAUTHENTICATED");
  });

  test("TCP + gate: a valid forge grant passes the gate and reaches dispatch", async () => {
    const p = port();
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
    });
    const grant = mintDoorGrant({
      door: "forge",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n",
      now: Date.now(),
    });
    const res = await send({ port: p }, leaseReq(grant));
    // Passed the gate → reached the handler → "not-configured" (no key here),
    // wrapped in an ok envelope. The point: NOT UNAUTHENTICATED.
    expect(res.ok).toBe(true);
    expect((res.result as { code?: string }).code).toBe("not-configured");
  });

  test("TCP + NO gate: serves but logs a loud WARN (footgun, never silent)", async () => {
    const p = port();
    const logs: Array<[string, string]> = [];
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      log: (level, msg) => logs.push([level, msg]),
    });
    const res = await send({ port: p }, leaseReq());
    expect(res.ok).toBe(true); // no gate → reaches dispatch (not-configured)
    expect(
      logs.some(([l, m]) => l === "WARN" && /CREDENTIAL door over TCP with NO grant gate/.test(m)),
    ).toBe(true);
  });

  test("UNIX: the gate is bypassed — a no-grant lease is served (held-ref = authority)", async () => {
    unixPath = join(tmpdir(), `forge-d-gate-${process.pid}-${counter++}.sock`);
    server = await runForgeDServe({
      socketPath: unixPath,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
    });
    const res = await send({ path: unixPath }, leaseReq());
    expect(res.ok).toBe(true); // reached dispatch with no grant — unix never gates
  });
});
