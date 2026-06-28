import { describe, expect, test } from "bun:test";

import type { FramedTransport } from "../../door/transport.ts";
import { createDoorBroker } from "../door-source.ts";

const EXPIRES = "2026-01-01T01:00:00Z";
const T0 = Date.parse("2026-01-01T00:00:00Z"); // 1h before expiry → fresh

describe("createDoorBroker", () => {
  test("leases a token over the door transport and caches it (one lease for a burst)", async () => {
    let leases = 0;
    const transport: FramedTransport = async () => {
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
    const transport: FramedTransport = async (req) => {
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
    expect(sent).toEqual({ kind: "lease", repositories: ["prx"], permissions: { contents: "read" } });
  });

  test("an error lease reply throws (fail-closed — no local fallback on the door path)", async () => {
    const transport: FramedTransport = async () => ({
      status: "error",
      code: "not-configured",
      message: "ghappd holds no GitHub App key",
    });
    const broker = createDoorBroker({ endpoint: "unix:///x", transport, now: () => T0 });
    await expect(broker.ensure()).rejects.toThrow(/not-configured/);
  });
});
