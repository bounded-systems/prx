import { describe, expect, test } from "bun:test";

import {
  createBeadViaDaemon,
  updateBeadViaDaemon,
  closeBeadViaDaemon,
  reopenBeadViaDaemon,
  depViaDaemon,
} from "../../src/beadsd/writes.ts";
import type { WithBeadsClientDeps } from "../../src/beadsd/client-factory.ts";
import type { BeadsRequest } from "../../src/beadsd/contract.ts";

// Raw `bd --json` echo (snake_case) — what the daemon returns on a write.
const RAW = { id: "prx-new", title: "do a thing", issue_type: "task", status: "open" };

/** withBeadsClient deps whose transport records the request and answers canned. */
function fakeDeps(reply: unknown, sink?: (req: BeadsRequest) => void): WithBeadsClientDeps {
  return {
    endpoint: { kind: "local", socket: "/tmp/writes-test.sock" },
    ensureUp: async () => {},
    localTransport: () => async (req) => {
      sink?.(req as BeadsRequest);
      return reply;
    },
  };
}

describe("daemon write helpers route through beadsd (GH-296 wave 2)", () => {
  test("createBeadViaDaemon sends a create request and parses the echo", async () => {
    let seen: BeadsRequest | undefined;
    const rec = await createBeadViaDaemon(
      { issueType: "task", title: "do a thing", priority: 1 },
      fakeDeps({ status: "ok", result: RAW }, (r) => (seen = r)),
    );
    expect(seen).toEqual({ kind: "create", issueType: "task", title: "do a thing", priority: 1 });
    expect(rec?.id).toBe("prx-new");
    expect(rec?.issueType).toBe("task");
  });

  test("createBeadViaDaemon omits optional fields when absent", async () => {
    let seen: BeadsRequest | undefined;
    await createBeadViaDaemon({ issueType: "bug", title: "t" }, fakeDeps({ status: "ok", result: RAW }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "create", issueType: "bug", title: "t" });
  });

  test("createBeadViaDaemon forwards externalRef + silent (write parity)", async () => {
    let seen: BeadsRequest | undefined;
    await createBeadViaDaemon(
      { issueType: "task", title: "t", externalRef: "https://github.com/o/r/issues/9", silent: true },
      fakeDeps({ status: "ok", result: RAW }, (r) => (seen = r)),
    );
    expect(seen).toEqual({
      kind: "create",
      issueType: "task",
      title: "t",
      externalRef: "https://github.com/o/r/issues/9",
      silent: true,
    });
  });

  test("updateBeadViaDaemon forwards issueType (write parity)", async () => {
    let seen: BeadsRequest | undefined;
    await updateBeadViaDaemon("prx-abb", { issueType: "bug" }, fakeDeps({ status: "ok", result: {} }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "update", id: "prx-abb", issueType: "bug" });
  });

  test("depViaDaemon sends a dep add/remove request (GH-296)", async () => {
    let seen: BeadsRequest | undefined;
    await depViaDaemon("add", "prx-a", "prx-b", "parent-child", fakeDeps({ status: "ok", result: null }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "dep", action: "add", from: "prx-a", to: "prx-b", depType: "parent-child" });

    await depViaDaemon("remove", "prx-a", "prx-b", undefined, fakeDeps({ status: "ok", result: null }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "dep", action: "remove", from: "prx-a", to: "prx-b" });
  });

  test("updateBeadViaDaemon forwards externalRef + notes (GH-296 write parity)", async () => {
    let seen: BeadsRequest | undefined;
    await updateBeadViaDaemon(
      "prx-abb",
      { externalRef: "https://github.com/o/r/issues/9", notes: "linked" },
      fakeDeps({ status: "ok", result: {} }, (r) => (seen = r)),
    );
    expect(seen).toEqual({
      kind: "update",
      id: "prx-abb",
      externalRef: "https://github.com/o/r/issues/9",
      notes: "linked",
    });
  });

  test("updateBeadViaDaemon sends only the changed fields", async () => {
    let seen: BeadsRequest | undefined;
    await updateBeadViaDaemon(
      "prx-abb",
      { status: "in_progress", assignee: "" },
      fakeDeps({ status: "ok", result: {} }, (r) => (seen = r)),
    );
    // empty assignee is preserved (clear semantics); absent priority is omitted
    expect(seen).toEqual({ kind: "update", id: "prx-abb", status: "in_progress", assignee: "" });
  });

  test("reopenBeadViaDaemon sends a reopen request", async () => {
    let seen: BeadsRequest | undefined;
    await reopenBeadViaDaemon("prx-abb", fakeDeps({ status: "ok", result: {} }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "reopen", id: "prx-abb" });
  });

  test("closeBeadViaDaemon sends a close request with the reason", async () => {
    let seen: BeadsRequest | undefined;
    await closeBeadViaDaemon("prx-abb", "done", fakeDeps({ status: "ok", result: {} }, (r) => (seen = r)));
    expect(seen).toEqual({ kind: "close", id: "prx-abb", reason: "done" });
  });

  test("an empty `{}` echo parses to null (success, no record), not an error", async () => {
    const rec = await updateBeadViaDaemon("prx-abb", { status: "closed" }, fakeDeps({ status: "ok", result: {} }));
    expect(rec).toBeNull();
  });

  test("a non-ok verdict throws with the bd-write detail", async () => {
    await expect(
      createBeadViaDaemon(
        { issueType: "task", title: "t" },
        fakeDeps({ status: "error", code: "bd-write", message: "blocked subcommand 'create'" }),
      ),
    ).rejects.toThrow(/bd-write: blocked/);
  });
});
