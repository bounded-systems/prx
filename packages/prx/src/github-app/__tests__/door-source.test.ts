import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { mintInstallationToken } from "../installation-token.ts";
import type { ForgeDTransport } from "../../forge-d/client.ts";
import { runForgeDServe, type ForgeDServer } from "../../forge-d/daemon.ts";
import { createDoorBroker } from "../door-source.ts";

const EXPIRES = "2026-01-01T01:00:00Z";
const T0 = Date.parse("2026-01-01T00:00:00Z"); // 1h before expiry → fresh

// The DEFAULT transport (no injection): drive createDoorBroker over a REAL
// forge-d serving the guest-room protocol, exercising `forgeDCallTransport`.
describe("createDoorBroker (default transport — real forge-d over guest-room call)", () => {
  let server: ForgeDServer | undefined;
  let socketPath: string | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (socketPath) rmSync(socketPath, { force: true });
    socketPath = undefined;
  });

  test("leases a token from a real forge-d via the default `call` transport", async () => {
    socketPath = join(tmpdir(), `ds-forge-d-${process.pid}.sock`);
    const mint = ((input) => {
      void input;
      return Promise.resolve({
        token: "ghs_e2e",
        expiresAt: EXPIRES,
        permissions: { contents: "read" },
      });
    }) as typeof mintInstallationToken;
    server = await runForgeDServe({
      socketPath,
      deps: { config: { issuer: "Iv1", privateKeyPem: "PEM", installationId: "1" }, mint },
    });
    const broker = createDoorBroker({ endpoint: socketPath, now: () => T0 });
    const tok = await broker.ensure();
    expect(tok.token).toBe("ghs_e2e");
    expect(tok.permissions.contents).toBe("read");
  });
});

describe("createDoorBroker", () => {
  test("leases a token over the door transport and caches it (one lease for a burst)", async () => {
    let leases = 0;
    const transport: ForgeDTransport = async () => {
      leases++;
      return {
        status: "ok",
        token: `ghs_${leases}`,
        expiresAt: EXPIRES,
        permissions: { contents: "read" },
      };
    };
    const broker = createDoorBroker({ endpoint: "unix:///x", transport, now: () => T0 });

    const a = await broker.ensure();
    const b = await broker.ensure();
    expect(leases).toBe(1);
    expect(a.token).toBe("ghs_1");
    expect(a.expiresAt).toBe(Date.parse(EXPIRES));
    expect(b.token).toBe("ghs_1");
  });

  test("forwards requested attenuation in the lease", async () => {
    let sent: unknown;
    const transport: ForgeDTransport = async (req) => {
      sent = req;
      return { status: "ok", token: "t", expiresAt: EXPIRES, permissions: {} };
    };
    const broker = createDoorBroker({
      endpoint: "unix:///x",
      transport,
      repositories: ["prx"],
      permissions: { contents: "read" },
      now: () => T0,
    });
    await broker.ensure();
    expect(sent).toEqual({
      kind: "lease",
      repositories: ["prx"],
      permissions: { contents: "read" },
    });
  });

  test("an error lease reply throws (fail-closed — no local fallback on the door path)", async () => {
    const transport: ForgeDTransport = async () => ({
      status: "error",
      code: "not-configured",
      message: "forge-d holds no GitHub App key",
    });
    const broker = createDoorBroker({ endpoint: "unix:///x", transport, now: () => T0 });
    await expect(broker.ensure()).rejects.toThrow(/not-configured/);
  });
});
