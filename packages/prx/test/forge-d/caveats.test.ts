import { afterEach, describe, expect, test } from "bun:test";

import { issuerKeys, mintDoorGrant } from "../../src/door/grant-issuer.ts";
import { runForgeDServe, type ForgeDServer } from "../../src/forge-d/daemon.ts";
import { FORGE_D_CAVEAT_VERIFIERS } from "../../src/forge-d/caveats.ts";
import { attenuate, checkCaveats, tcp, unix, type DoorGrant } from "@bounded-systems/guest-room";
import { connect } from "node:net";

const baseGrant: DoorGrant = {
  name: "forge",
  host: unix("/x"),
  guest: tcp("h", 0),
  env: "E",
  grants: "g",
  use: "u",
};

const AUDIENCE = "claude-room";

type Resp = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

function send(port: number, req: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, () => c.write(JSON.stringify(req) + "\n"));
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

const leaseReq = (grant: unknown, params: Record<string, unknown> = {}) => ({
  id: "1",
  method: "lease",
  params,
  grant,
});

describe("FORGE_D_CAVEAT_VERIFIERS (unit)", () => {
  test("repos: satisfied only when every requested repo is in the OR-set", () => {
    const grant = attenuate(baseGrant, ["repos=o/a,o/b"]);
    expect(checkCaveats(grant, { repositories: ["o/a"] }, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(true);
    expect(checkCaveats(grant, { repositories: ["o/a", "o/b"] }, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(
      true,
    );
    expect(checkCaveats(grant, { repositories: ["o/c"] }, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(false);
    // omission is not a bypass — requesting "everything" when narrowed is denied.
    expect(checkCaveats(grant, {}, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(false);
  });

  test("perms: satisfied only when every requested key:value pair is in the OR-set", () => {
    const grant = attenuate(baseGrant, ["perms=contents:read"]);
    expect(
      checkCaveats(grant, { permissions: { contents: "read" } }, FORGE_D_CAVEAT_VERIFIERS).ok,
    ).toBe(true);
    expect(
      checkCaveats(grant, { permissions: { contents: "write" } }, FORGE_D_CAVEAT_VERIFIERS).ok,
    ).toBe(false);
    expect(checkCaveats(grant, {}, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(false);
  });

  test("no caveats: any request passes (unattenuated grant)", () => {
    expect(
      checkCaveats(baseGrant, { repositories: ["anything"] }, FORGE_D_CAVEAT_VERIFIERS).ok,
    ).toBe(true);
    expect(checkCaveats(baseGrant, {}, FORGE_D_CAVEAT_VERIFIERS).ok).toBe(true);
  });
});

describe("withForgeCaveats over runForgeDServe (TCP)", () => {
  let server: ForgeDServer | undefined;
  let counter = 0;
  const port = () => 43000 + (process.pid % 2000) + counter++;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  test("a repos-attenuated grant may lease only the named repository", async () => {
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
      caveats: ["repos=o/allowed"],
    });

    const allowed = await send(p, leaseReq(grant, { repositories: ["o/allowed"] }));
    expect(allowed.ok).toBe(true);
    expect((allowed.result as { code?: string }).code).toBe("not-configured"); // reached dispatch

    const denied = await send(p, leaseReq(grant, { repositories: ["o/other"] }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("UNAUTHENTICATED");

    // omitting `repositories` entirely (asking for the installation's full
    // scope) must not bypass the narrowing.
    const omitted = await send(p, leaseReq(grant));
    expect(omitted.ok).toBe(false);
    expect(omitted.error?.code).toBe("UNAUTHENTICATED");
  });

  test("a perms-attenuated grant may lease only the named permission", async () => {
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
      caveats: ["perms=contents:read"],
    });

    const allowed = await send(p, leaseReq(grant, { permissions: { contents: "read" } }));
    expect(allowed.ok).toBe(true);

    const denied = await send(p, leaseReq(grant, { permissions: { contents: "write" } }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("UNAUTHENTICATED");
  });

  test("an unattenuated grant (no caveats) still works as before (backward compatible)", async () => {
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
    const res = await send(p, leaseReq(grant, { repositories: ["anything"] }));
    expect(res.ok).toBe(true);
    expect((res.result as { code?: string }).code).toBe("not-configured");
  });
});
