import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  signGrant,
  tcp,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
  type SignedGrant,
} from "@bounded-systems/guest-room";

import { runKeeperServe, type KeeperServer } from "../../src/keeperd/daemon.ts";

// A published test issuer.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const keys: IssuerKeys = { keys: [{ kid: "k1", publicKeyPem }] };
const sign = (d: string): string =>
  cryptoSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64");
const AUDIENCE = "claude-room";

function mintGrant(door = "keeper", audience = AUDIENCE): SignedGrant {
  const grant: DoorGrant = {
    name: door,
    host: unix("/run/prx/doors/keeperd.sock"),
    guest: tcp("127.0.0.1", 9999),
    env: "KEEPERD_SOCK",
    grants: "git push via keeperd",
    use: "present this grant to push",
  };
  const binding: GrantBinding = { audience, exp: Date.now() + 60_000, nonce: "n", keyId: "k1" };
  return signGrant(grant, binding, sign);
}

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

const pushReq = (grant?: SignedGrant) => ({
  id: "1",
  method: "import-and-push",
  params: {},
  ...(grant ? { grant } : {}),
});

describe("runKeeperServe TCP grant gate (prx-8uf2)", () => {
  let server: KeeperServer | undefined;
  let unixPath: string | undefined;
  let counter = 0;
  const port = () => 41000 + (process.pid % 2000) + counter++;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (unixPath) rmSync(unixPath, { force: true });
    unixPath = undefined;
  });

  test("TCP + gate: a request with NO grant is denied before dispatch", async () => {
    const p = port();
    server = await runKeeperServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys, audience: AUDIENCE },
    });
    const res = await send({ port: p }, pushReq());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNAUTHENTICATED");
  });

  test("TCP + gate: a grant minted for a DIFFERENT door is denied", async () => {
    const p = port();
    server = await runKeeperServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys, audience: AUDIENCE },
    });
    const res = await send({ port: p }, pushReq(mintGrant("forge")));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNAUTHENTICATED");
  });

  test("TCP + gate: a valid grant passes the gate and reaches dispatch", async () => {
    const p = port();
    server = await runKeeperServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys, audience: AUDIENCE },
    });
    // Minimal params fail the keeper wire contract → a bad-request VERDICT wrapped
    // in an ok envelope. The point: it is NOT UNAUTHENTICATED — the gate let it in.
    const res = await send({ port: p }, pushReq(mintGrant()));
    expect(res.ok).toBe(true);
    expect((res.result as { code?: string }).code).toBe("bad-request");
  });

  test("TCP + NO gate: serves unauthenticated but logs a loud WARN (footgun, never silent)", async () => {
    const p = port();
    const logs: Array<[string, string]> = [];
    server = await runKeeperServe({
      socketPath: `127.0.0.1:${p}`,
      log: (level, msg) => logs.push([level, msg]),
    });
    const res = await send({ port: p }, pushReq()); // no grant, no gate → reaches dispatch
    expect(res.ok).toBe(true);
    expect(
      logs.some(([l, m]) => l === "WARN" && /CREDENTIAL door over TCP with NO grant gate/.test(m)),
    ).toBe(true);
  });

  test("UNIX: the gate is bypassed — a no-grant request is served (held-ref = authority)", async () => {
    unixPath = join(tmpdir(), `keeperd-gate-${process.pid}-${counter++}.sock`);
    // A grantGate is supplied, but a unix listener must ignore it entirely.
    server = await runKeeperServe({
      socketPath: unixPath,
      grantGate: { keys, audience: AUDIENCE },
    });
    const res = await send({ path: unixPath }, pushReq());
    expect(res.ok).toBe(true); // reached dispatch with no grant — unix never gates
  });
});
