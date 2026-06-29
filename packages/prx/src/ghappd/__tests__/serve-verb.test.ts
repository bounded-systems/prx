import { describe, expect, test } from "bun:test";

import type { BrokerConfig } from "../../github-app/broker-config.ts";
import type { GhappdServeOptions, GhappdServer } from "../daemon.ts";
import { ghappServeVerb, type GhappServeDeps } from "../serve-verb.ts";

const CONFIG: BrokerConfig = {
  issuer: "Iv1",
  privateKeyPem: "PEM",
  installationId: "1",
  source: "inline",
};

/** A GhappdServer stub whose `closed` resolves on the next tick so run() unblocks. */
function fakeServer(): GhappdServer {
  return {
    close: async () => {},
    closed: new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

describe("ghappServeVerb", () => {
  test("resolves the App key, serves with it as deps, logs listening", async () => {
    let served: GhappdServeOptions | undefined;
    const logs: string[] = [];
    const deps: GhappServeDeps = {
      resolveConfig: () => CONFIG,
      readFile: () => "PEM",
      serve: async (opts) => {
        served = opts;
        return fakeServer();
      },
      log: (l) => logs.push(l),
    };

    const out = await ghappServeVerb.run({ socket: "/tmp/ghappd.sock" }, deps);

    expect(served?.socketPath).toBe("/tmp/ghappd.sock");
    expect(served?.deps?.config?.issuer).toBe("Iv1");
    expect(logs.some((l) => l.includes("listening on /tmp/ghappd.sock"))).toBe(true);
    expect(out).toEqual({ socket: "/tmp/ghappd.sock", configured: true });
  });

  test("serves without a key when unconfigured (configured:false; leases will error)", async () => {
    const logs: string[] = [];
    const deps: GhappServeDeps = {
      resolveConfig: () => null,
      readFile: () => {
        throw new Error("should not read");
      },
      serve: async () => fakeServer(),
      log: (l) => logs.push(l),
    };

    const out = await ghappServeVerb.run({ socket: "/tmp/x.sock" }, deps);

    expect(out.configured).toBe(false);
    expect(logs.some((l) => l.includes("no App key configured"))).toBe(true);
  });
});
