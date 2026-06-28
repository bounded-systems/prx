import type { Socket } from "node:net";

import { describe, expect, test } from "bun:test";

import { FrameDecoder, encodeFrame } from "../../door/framing.ts";
import type { mintInstallationToken } from "../../github-app/installation-token.ts";
import { GhappdResponseSchema, type GhappdRequest } from "../contract.ts";
import {
  type GhappdConfig,
  handleGhappdRequest,
  serveGhappdConnection,
} from "../daemon.ts";

const CONFIG: GhappdConfig = {
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

describe("handleGhappdRequest", () => {
  test("not-configured: replies error when ghappd holds no key", async () => {
    const r = await handleGhappdRequest({ kind: "lease" }, {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.code).toBe("not-configured");
  });

  test("leases a token from the held key; the PEM is never in the reply", async () => {
    const r = await handleGhappdRequest(
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
    await handleGhappdRequest(
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
    const r = await handleGhappdRequest(
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

/** A minimal in-memory Socket: captures writes, exposes the data handler. */
function fakeSocket(): { socket: Socket; emit: (chunk: Buffer) => void; writes: Buffer[] } {
  const writes: Buffer[] = [];
  let onData: ((chunk: Buffer) => void) | undefined;
  const socket = {
    on(event: string, cb: (chunk: Buffer) => void) {
      if (event === "data") onData = cb;
      return this;
    },
    write(buf: Buffer) {
      writes.push(buf);
      return true;
    },
  } as unknown as Socket;
  return { socket, writes, emit: (chunk) => onData?.(chunk) };
}

describe("serveGhappdConnection", () => {
  test("decodes a framed lease, dispatches, and writes a framed ok reply", async () => {
    const { socket, writes, emit } = fakeSocket();
    serveGhappdConnection(socket, (req: GhappdRequest) =>
      handleGhappdRequest(req, {
        config: CONFIG,
        mint: mintReturning(async () => ({
          token: "ghs_wire",
          expiresAt: "2026-06-27T23:59:59Z",
          permissions: {},
        })),
      }),
    );

    emit(encodeFrame({ kind: "lease" }));
    await new Promise((r) => setTimeout(r, 5)); // let the response chain settle

    expect(writes).toHaveLength(1);
    const [reply] = new FrameDecoder().push(writes[0]!);
    const parsed = GhappdResponseSchema.parse(reply);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.token).toBe("ghs_wire");
  });

  test("a contract-violating frame gets a bad-request reply", async () => {
    const { socket, writes, emit } = fakeSocket();
    serveGhappdConnection(socket, (req: GhappdRequest) => handleGhappdRequest(req, { config: CONFIG }));

    emit(encodeFrame({ kind: "not-a-real-op" }));
    await new Promise((r) => setTimeout(r, 5));

    const [reply] = new FrameDecoder().push(writes[0]!);
    const parsed = GhappdResponseSchema.parse(reply);
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") expect(parsed.code).toBe("bad-request");
  });
});
