import { describe, expect, test } from "bun:test";

import { conciergeServeVerb, type ConciergeServeDeps } from "../../src/concierge/serve-verb.ts";
import type { ConciergeServeOptions, ConciergeServer } from "../../src/concierge/daemon.ts";

/** A ConciergeServer stub whose `closed` resolves next tick so run() unblocks. */
function fakeServer(): ConciergeServer {
  return { close: async () => {}, closed: new Promise<void>((resolve) => setTimeout(resolve, 0)) };
}

describe("conciergeServeVerb", () => {
  test("serves on the socket, logs listening, returns the socket", async () => {
    let served: ConciergeServeOptions | undefined;
    const logs: string[] = [];
    const deps: ConciergeServeDeps = {
      serve: async (opts) => {
        served = opts;
        return fakeServer();
      },
      log: (line) => logs.push(line),
    };

    const out = await conciergeServeVerb.run(
      { socket: "/tmp/concierged.sock", pidfile: "/tmp/concierged.pid" },
      deps,
    );

    expect(out).toEqual({ socket: "/tmp/concierged.sock" });
    expect(served?.socketPath).toBe("/tmp/concierged.sock");
    expect(served?.pidfile).toBe("/tmp/concierged.pid");
    expect(logs.some((l) => /listening on \/tmp\/concierged.sock/.test(l))).toBe(true);
  });
});
