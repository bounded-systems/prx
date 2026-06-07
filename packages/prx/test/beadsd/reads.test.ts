import { describe, expect, test } from "bun:test";

import { loadAllBeadsViaDaemon, showBeadViaDaemon } from "../../src/beadsd/reads.ts";
import type { WithBeadsClientDeps } from "../../src/beadsd/client-factory.ts";
import type { BeadsRequest } from "../../src/beadsd/contract.ts";

// The RAW `bd --json` shape the daemon actually returns: snake_case fields, no
// derived `externalRefs` / `externalIssueNumber`. The readers MUST run the same
// parse transform the local `bd list` path uses — this is the regression guard
// for the bug where the daemon result was cast straight to BeadsRecord.
const RAW = {
  id: "prx-abb",
  title: "do a thing",
  external_ref: "https://github.com/o/r/issues/123",
  issue_type: "task",
  source_system: "github",
  updated_at: "2026-01-01T00:00:00Z",
};

/** A withBeadsClient deps bundle whose transport answers with a canned reply. */
function fakeDeps(reply: unknown, sink?: (req: BeadsRequest) => void): WithBeadsClientDeps {
  return {
    endpoint: { kind: "local", socket: "/tmp/reads-test.sock" },
    ensureUp: async () => {},
    localTransport: () => async (req) => {
      sink?.(req as BeadsRequest);
      return reply;
    },
  };
}

describe("daemon readers parse raw bd --json into BeadsRecord (GH-296)", () => {
  test("loadAllBeadsViaDaemon maps snake_case → camelCase and derives refs", async () => {
    const recs = await loadAllBeadsViaDaemon(fakeDeps({ status: "ok", result: [RAW] }));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.externalRef).toBe("https://github.com/o/r/issues/123");
    expect(recs[0]!.issueType).toBe("task");
    expect(recs[0]!.sourceSystem).toBe("github");
    expect(recs[0]!.externalIssueNumber).toBe(123);
    expect(recs[0]!.externalRefs.gh).toBe("https://github.com/o/r/issues/123");
  });

  test("loadAllBeadsViaDaemon issues an aggregate `list --all --limit 0` query", async () => {
    let seen: BeadsRequest | undefined;
    await loadAllBeadsViaDaemon(fakeDeps({ status: "ok", result: [] }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "list", all: true, limit: 0 });
  });

  test("showBeadViaDaemon issues a TARGETED `show <id>` and parses the one record", async () => {
    let seen: BeadsRequest | undefined;
    const rec = await showBeadViaDaemon("prx-abb", fakeDeps({ status: "ok", result: [RAW] }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "show", id: "prx-abb" });
    expect(rec?.id).toBe("prx-abb");
    expect(rec?.externalIssueNumber).toBe(123);
  });

  test("showBeadViaDaemon unwraps a bare (non-array) result too", async () => {
    const rec = await showBeadViaDaemon("prx-abb", fakeDeps({ status: "ok", result: RAW }));
    expect(rec?.id).toBe("prx-abb");
  });

  test("showBeadViaDaemon returns null on a not-found error verdict (not an exception)", async () => {
    const rec = await showBeadViaDaemon(
      "nope",
      fakeDeps({ status: "error", code: "not-found", message: "no record found" }),
    );
    expect(rec).toBeNull();
  });

  test("showBeadViaDaemon throws on a non-not-found error verdict", async () => {
    await expect(
      showBeadViaDaemon("x", fakeDeps({ status: "error", code: "bd-read", message: "boom" })),
    ).rejects.toThrow(/bd-read/);
  });
});
