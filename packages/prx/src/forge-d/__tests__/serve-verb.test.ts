import { describe, expect, test } from "bun:test";

import type { BrokerConfig } from "../../github-app/broker-config.ts";
import type { ForgeDServeOptions, ForgeDServer } from "../daemon.ts";
import { forgeServeVerb, type ForgeServeDeps } from "../serve-verb.ts";

const CONFIG: BrokerConfig = {
  issuer: "Iv1",
  privateKeyPem: "PEM",
  installationId: "1",
  source: "inline",
};

/** A ForgeDServer stub whose `closed` resolves on the next tick so run() unblocks. */
function fakeServer(): ForgeDServer {
  return {
    close: async () => {},
    closed: new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

describe("forgeServeVerb", () => {
  test("resolves the App key, serves with it as deps, logs listening", async () => {
    let served: ForgeDServeOptions | undefined;
    const logs: string[] = [];
    const deps: ForgeServeDeps = {
      resolveConfig: () => CONFIG,
      readFile: () => "PEM",
      serve: async (opts) => {
        served = opts;
        return fakeServer();
      },
      log: (l) => logs.push(l),
    };

    const out = await forgeServeVerb.run({ socket: "/tmp/forge-d.sock" }, deps);

    expect(served?.socketPath).toBe("/tmp/forge-d.sock");
    expect(served?.deps?.config?.issuer).toBe("Iv1");
    expect(logs.some((l) => l.includes("listening on /tmp/forge-d.sock"))).toBe(true);
    expect(out).toEqual({ socket: "/tmp/forge-d.sock", configured: true });
  });

  test("serves without a key when unconfigured (configured:false; leases will error)", async () => {
    const logs: string[] = [];
    const deps: ForgeServeDeps = {
      resolveConfig: () => null,
      readFile: () => {
        throw new Error("should not read");
      },
      serve: async () => fakeServer(),
      log: (l) => logs.push(l),
    };

    const out = await forgeServeVerb.run({ socket: "/tmp/x.sock" }, deps);

    expect(out.configured).toBe(false);
    expect(logs.some((l) => l.includes("no App key configured"))).toBe(true);
  });
});
