import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IssuerKeys, SignedGrant } from "@bounded-systems/guest-room";
import { call } from "@bounded-systems/guest-room/protocol";

import { buildDoorAuthorizer } from "../../src/door/grant-gate.ts";
import { runConciergeServe, type ConciergeServer } from "../../src/concierge/daemon.ts";

const AUDIENCE = "claude-room";

describe("concierged (guest-room protocol, end-to-end)", () => {
  let server: ConciergeServer | undefined;
  let socketPath: string | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (socketPath) rmSync(socketPath, { force: true });
    socketPath = undefined;
  });

  async function start(): Promise<string> {
    socketPath = join(tmpdir(), `concierged-${process.pid}-${counter++}.sock`);
    server = await runConciergeServe({ socketPath });
    return socketPath;
  }

  test("register → resolve → present: the resolved grant passes the serving room's gate", async () => {
    const path = await start();
    // A box that serves the "ghapp" capability registers it.
    const reg = await call<{ ttl: number }>(path, "register", {
      capability: "ghapp",
      door: "/run/prx/doors/ghappd.sock",
      lease: 300,
    });
    expect(reg.ttl).toBe(300);

    // A consumer in `claude-room` resolves it → a signed grant.
    const { door: grant } = await call<{ door: SignedGrant }>(path, "resolve", {
      capability: "ghapp",
      want: [],
      audience: AUDIENCE,
    });
    expect(grant.name).toBe("ghapp");
    expect(grant.binding.audience).toBe(AUDIENCE);

    // The serving room's gate — configured with THIS concierge's published keys —
    // accepts the grant. This is the full loop: resolve → present → verify.
    const keys = await call<IssuerKeys>(path, "keys");
    const authorize = buildDoorAuthorizer("ghapp", { keys, audience: AUDIENCE });
    expect(authorize({ id: "1", method: "lease", grant } as never)).toBe(true);

    // A grant for THIS door is rejected at a DIFFERENT door's gate (audience-binding).
    const keeperGate = buildDoorAuthorizer("keeper", { keys, audience: AUDIENCE });
    expect(keeperGate({ id: "1", method: "import-and-push", grant } as never)).toBe(false);
  });

  test("resolve rejects when no live provider serves the capability", async () => {
    const path = await start();
    await expect(call(path, "resolve", { capability: "nope", want: [], audience: AUDIENCE })).rejects.toThrow();
  });

  test("list reports registered capabilities", async () => {
    const path = await start();
    await call(path, "register", { capability: "ghapp", door: "/g.sock", grants: "gh app", lease: 300 });
    await call(path, "register", { capability: "keeper", door: "/k.sock", lease: 300 });
    const { capabilities } = await call<{ capabilities: Array<{ capability: string }> }>(path, "list");
    expect(capabilities.map((c) => c.capability).sort()).toEqual(["ghapp", "keeper"]);
  });

  test("register fails closed on a malformed request (no capability/door)", async () => {
    const path = await start();
    await expect(call(path, "register", { capability: "x" })).rejects.toThrow();
  });
});
