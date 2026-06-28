import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  appJwt,
  mintInstallationToken,
  type InstallationToken,
} from "../installation-token.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const PUB = publicKey.export({ type: "spki", format: "pem" }) as string;
const NOW = 1_700_000_000_000; // fixed ms

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("appJwt", () => {
  test("signs a verifiable RS256 JWT with iss + skewed iat/exp", () => {
    const jwt = appJwt("Iv1.deadbeef", PEM, () => NOW);
    const [h, p, sig] = jwt.split(".");

    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decode(p!);
    expect(payload.iss).toBe("Iv1.deadbeef");
    const iat = Math.floor(NOW / 1000) - 60;
    expect(payload.iat).toBe(iat);
    expect(payload.exp).toBe(iat + 600); // ~10 min window
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);

    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(PUB, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  test("POSTs to the installation endpoint with a Bearer JWT and parses the token", async () => {
    const seen: { url: string; auth: string; method: string } = { url: "", auth: "", method: "" };
    const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      seen.method = init?.method ?? "";
      return new Response(
        JSON.stringify({
          token: "ghs_secret",
          expires_at: "2026-06-27T23:59:59Z",
          permissions: { pull_requests: "write", contents: "read" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result: InstallationToken = await mintInstallationToken(
      { issuer: "12345", privateKeyPem: PEM, installationId: "138039680" },
      { fetch: fakeFetch, now: () => NOW, apiBaseUrl: "https://api.github.test" },
    );

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("https://api.github.test/app/installations/138039680/access_tokens");
    expect(seen.auth).toMatch(/^Bearer eyJ/); // a JWT
    expect(result.token).toBe("ghs_secret");
    expect(result.expiresAt).toBe("2026-06-27T23:59:59Z");
    expect(result.permissions.pull_requests).toBe("write");
  });

  test("unattenuated call sends no request body (full installation scope)", async () => {
    let sawBody: string | undefined;
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      sawBody = init?.body as string | undefined;
      return new Response(JSON.stringify({ token: "t", expires_at: "2026-06-27T23:59:59Z" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    await mintInstallationToken(
      { issuer: "12345", privateKeyPem: PEM, installationId: "1" },
      { fetch: fakeFetch, now: () => NOW },
    );
    expect(sawBody).toBeUndefined();
  });

  test("attenuated call sends repositories + permissions in the JSON body", async () => {
    const seen: { body: string; contentType: string } = { body: "", contentType: "" };
    const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      seen.body = String(init?.body ?? "");
      seen.contentType = String((init?.headers as Record<string, string>)?.["Content-Type"] ?? "");
      return new Response(JSON.stringify({ token: "t", expires_at: "2026-06-27T23:59:59Z" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    await mintInstallationToken(
      {
        issuer: "12345",
        privateKeyPem: PEM,
        installationId: "1",
        repositories: ["prx"],
        permissions: { contents: "read" },
      },
      { fetch: fakeFetch, now: () => NOW },
    );
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body)).toEqual({ repositories: ["prx"], permissions: { contents: "read" } });
  });

  test("throws with status + body when GitHub rejects the request", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("bad key", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;

    await expect(
      mintInstallationToken(
        { issuer: "12345", privateKeyPem: PEM, installationId: "1" },
        { fetch: fakeFetch, now: () => NOW },
      ),
    ).rejects.toThrow(/401.*bad key/s);
  });
});
