import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { call } from "@bounded-systems/guest-room/protocol";

import type { mintInstallationToken } from "../../github-app/installation-token.ts";
import {
  type ForgeDConfig,
  type ForgeDDaemonDeps,
  type ForgeDServer,
  handleForgeDRequest,
  runForgeDServe,
} from "../daemon.ts";

const CONFIG: ForgeDConfig = {
  issuer: "Iv1",
  privateKeyPem: "SECRET-PEM",
  installationId: "138039680",
};

/** A mint fake from a thunk, typed as the real primitive. */
function mintReturning(
  impl: (input: {
    repositories?: readonly string[];
    permissions?: Readonly<Record<string, string>>;
  }) => Promise<{ token: string; expiresAt: string; permissions: Record<string, string> }>,
): typeof mintInstallationToken {
  return ((input) => impl(input)) as typeof mintInstallationToken;
}

describe("handleForgeDRequest", () => {
  test("not-configured: replies error when forge-d holds no key", async () => {
    const r = await handleForgeDRequest({ kind: "lease" }, {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.code).toBe("not-configured");
  });

  test("leases a token from the held key; the PEM is never in the reply", async () => {
    const r = await handleForgeDRequest(
      { kind: "lease" },
      {
        config: CONFIG,
        mint: mintReturning(async () => ({
          token: "ghs_leased",
          expiresAt: "2026-06-27T23:59:59Z",
          permissions: { contents: "read" },
        })),
      },
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.token).toBe("ghs_leased");
      expect(r.expiresAt).toBe("2026-06-27T23:59:59Z");
      expect(r.permissions.contents).toBe("read");
    }
    expect(JSON.stringify(r)).not.toContain("SECRET-PEM");
  });

  test("forwards the request's attenuation to mint", async () => {
    let seen: {
      repositories: readonly string[] | undefined;
      permissions: Readonly<Record<string, string>> | undefined;
    } = { repositories: undefined, permissions: undefined };
    await handleForgeDRequest(
      { kind: "lease", repositories: ["prx"], permissions: { contents: "read" } },
      {
        config: CONFIG,
        mint: mintReturning(async (input) => {
          seen = { repositories: input.repositories, permissions: input.permissions };
          return { token: "t", expiresAt: "2026-06-27T23:59:59Z", permissions: {} };
        }),
      },
    );
    expect(seen.repositories).toEqual(["prx"]);
    expect(seen.permissions).toEqual({ contents: "read" });
  });

  test("mint failure becomes an error reply, never throws", async () => {
    const r = await handleForgeDRequest(
      { kind: "lease" },
      {
        config: CONFIG,
        mint: mintReturning(async () => {
          throw new Error("github said no");
        }),
      },
    );
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.code).toBe("mint-failed");
      expect(r.message).toContain("github said no");
    }
  });
});

// The guest-room door protocol end-to-end (prx→guest-room convergence): the same
// `lease` wire a real forge-d consumer drives, over a real unix socket.
describe("runForgeDServe (guest-room protocol, end-to-end)", () => {
  let server: ForgeDServer | undefined;
  let socketPath: string | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (socketPath) rmSync(socketPath, { force: true });
    socketPath = undefined;
  });

  async function start(deps: ForgeDDaemonDeps): Promise<string> {
    socketPath = join(tmpdir(), `forge-d-${process.pid}-${counter++}.sock`);
    server = await runForgeDServe({ socketPath, deps });
    return socketPath;
  }

  type Reply = { status: string; token?: string; code?: string };

  test("leases a token over the `lease` method", async () => {
    const path = await start({
      config: CONFIG,
      mint: mintReturning(async () => ({
        token: "ghs_wire",
        expiresAt: "2026-06-27T23:59:59Z",
        permissions: {},
      })),
    });
    const reply = (await call(path, "lease", {})) as Reply;
    expect(reply.status).toBe("ok");
    expect(reply.token).toBe("ghs_wire");
  });

  test("forwards attenuation params to the handler", async () => {
    let seen: readonly string[] | undefined;
    const path = await start({
      config: CONFIG,
      mint: mintReturning(async (input) => {
        seen = input.repositories;
        return { token: "t", expiresAt: "2026-06-27T23:59:59Z", permissions: {} };
      }),
    });
    await call(path, "lease", { repositories: ["prx"], permissions: { contents: "read" } });
    expect(seen).toEqual(["prx"]);
  });

  test("a contract-violating lease body replies bad-request (daemon stays up)", async () => {
    const path = await start({ config: CONFIG });
    const reply = (await call(path, "lease", { repositories: [123] })) as Reply;
    expect(reply.status).toBe("error");
    expect(reply.code).toBe("bad-request");
  });

  test("not-configured replies error over the wire (no key held)", async () => {
    const path = await start({});
    const reply = (await call(path, "lease", {})) as Reply;
    expect(reply.status).toBe("error");
    expect(reply.code).toBe("not-configured");
  });
});
