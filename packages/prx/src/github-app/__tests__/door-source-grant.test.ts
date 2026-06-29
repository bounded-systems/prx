import { afterEach, describe, expect, test } from "bun:test";

import { cachingGrantProvider } from "../../door/grant-provider.ts";
import { issuerKeys, mintDoorGrant } from "../../door/grant-issuer.ts";
import type { mintInstallationToken } from "../installation-token.ts";
import { runForgeDServe, type ForgeDServer } from "../../forge-d/daemon.ts";
import { createDoorBroker } from "../door-source.ts";

const AUDIENCE = "claude-room";
const EXPIRES = "2099-01-01T00:00:00Z";

const leaseMint = (() => ({
  token: "ghs_granted",
  expiresAt: EXPIRES,
  permissions: { contents: "read" },
})) as unknown as typeof mintInstallationToken;

// A grant provider backed by the real issuer — in prod this `acquire` is a
// concierge call; the provider's refresh/present logic is identical.
const forgeGrantProvider = () =>
  cachingGrantProvider({
    acquire: () =>
      mintDoorGrant({ door: "forge", audience: AUDIENCE, ttlSeconds: 60, nonce: "n", now: Date.now() }),
  });

describe("createDoorBroker over a GATED forge-d (grant presentation, prx-8uf2)", () => {
  let server: ForgeDServer | undefined;
  let counter = 0;
  const port = () => 43000 + (process.pid % 2000) + counter++;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  test("presents a signed grant → passes the gate → leases a token", async () => {
    const p = port();
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
      deps: { config: { issuer: "Iv1", privateKeyPem: "PEM", installationId: "1" }, mint: leaseMint },
    });
    const broker = createDoorBroker({
      endpoint: `127.0.0.1:${p}`,
      grantProvider: forgeGrantProvider(),
    });
    const tok = await broker.ensure();
    expect(tok.token).toBe("ghs_granted");
  });

  test("WITHOUT a grant the gated door rejects the lease (fail-closed)", async () => {
    const p = port();
    server = await runForgeDServe({
      socketPath: `127.0.0.1:${p}`,
      grantGate: { keys: issuerKeys(), audience: AUDIENCE },
      deps: { config: { issuer: "Iv1", privateKeyPem: "PEM", installationId: "1" }, mint: leaseMint },
    });
    // No grantProvider → no grant on the wire → the gate denies before dispatch,
    // which guest-room `call` surfaces as a rejection (fail-closed lease).
    const broker = createDoorBroker({ endpoint: `127.0.0.1:${p}` });
    await expect(broker.ensure()).rejects.toThrow();
  });
});
