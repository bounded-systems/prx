// guestRoomKeeperTransport speaks the guest-room door protocol: it sends the
// keeper request as the `import-and-push` method and returns the daemon's
// verdict. (Used by the legacy runKeeperRemote path; the live door push now
// consumes door-kit directly.)
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDoorHandlers } from "@bounded-systems/guest-room/protocol";

import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";
import { guestRoomKeeperTransport } from "../../src/keeperd/protocol-transport.ts";

describe("guestRoomKeeperTransport", () => {
  let server: { stop: () => void } | undefined;
  afterEach(() => server?.stop());

  test("calls the import-and-push door method and returns the verdict", async () => {
    const sock = join(tmpdir(), `kt-${process.pid}-${crypto.randomUUID()}.sock`);
    let received: Record<string, unknown> | undefined;
    server = Bun.listen({
      unix: sock,
      socket: createDoorHandlers(
        "keeper",
        {
          "import-and-push": (p) => {
            received = p;
            return { status: "ok", commitSha: "c", pushedRef: "refs/heads/x" };
          },
        },
        () => {},
      ),
    });

    const request: KeeperRemoteRequest = {
      kind: "import-and-push",
      bundleBase64: "QkFTRTY0",
      commitSha: "c".repeat(40),
      branch: "GH-1",
      remote: "origin",
    };
    const res = await guestRoomKeeperTransport(sock)(request);
    expect(res).toEqual({ status: "ok", commitSha: "c", pushedRef: "refs/heads/x" });
    expect(received?.kind).toBe("import-and-push");
  });
});
