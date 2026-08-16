import { describe, expect, test } from "bun:test";

import {
  KeeperRemoteRequestSchema,
  KeeperRemoteResponseSchema,
} from "../../src/keeperd/contract.ts";

const VALID_REQUEST = {
  kind: "import-and-push" as const,
  bundleBase64: "ZGVhZGJlZWY=",
  commitSha: "a".repeat(40),
  branch: "GH-456",
  remote: "origin",
};

describe("keeperd wire contract — request", () => {
  test("accepts a well-formed import-and-push request", () => {
    const parsed = KeeperRemoteRequestSchema.parse(VALID_REQUEST);
    expect(parsed.kind).toBe("import-and-push");
    expect(parsed.pushArgs).toBeUndefined();
    expect(parsed.ledgerRef).toBeUndefined();
  });

  test("threads optional pushArgs + ledgerRef when present", () => {
    const parsed = KeeperRemoteRequestSchema.parse({
      ...VALID_REQUEST,
      pushArgs: ["--force-with-lease"],
      ledgerRef: "refs/prx/ledger",
    });
    expect(parsed.pushArgs).toEqual(["--force-with-lease"]);
    expect(parsed.ledgerRef).toBe("refs/prx/ledger");
  });

  test("rejects a non-40-hex commitSha", () => {
    expect(
      KeeperRemoteRequestSchema.safeParse({ ...VALID_REQUEST, commitSha: "xyz" }).success,
    ).toBe(false);
  });

  test("rejects the retired commit-and-push kind", () => {
    expect(
      KeeperRemoteRequestSchema.safeParse({ ...VALID_REQUEST, kind: "commit-and-push" }).success,
    ).toBe(false);
  });

  test("rejects an empty bundle — no push over objects the daemon lacks", () => {
    expect(
      KeeperRemoteRequestSchema.safeParse({ ...VALID_REQUEST, bundleBase64: "" }).success,
    ).toBe(false);
  });

  test("rejects an empty branch and an empty remote", () => {
    expect(KeeperRemoteRequestSchema.safeParse({ ...VALID_REQUEST, branch: "" }).success).toBe(
      false,
    );
    expect(KeeperRemoteRequestSchema.safeParse({ ...VALID_REQUEST, remote: "" }).success).toBe(
      false,
    );
  });
});

describe("keeperd wire contract — response", () => {
  test("accepts an ok verdict with the pushed identity", () => {
    const parsed = KeeperRemoteResponseSchema.parse({
      status: "ok",
      commitSha: "c".repeat(40),
      pushedRef: "refs/heads/GH-456",
    });
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.pushedRef).toBe("refs/heads/GH-456");
  });

  test("accepts an error verdict with code + git exit code", () => {
    const parsed = KeeperRemoteResponseSchema.parse({
      status: "error",
      code: "git-write",
      message: "git push failed (128): rejected",
      exitCode: 128,
    });
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") {
      expect(parsed.code).toBe("git-write");
      expect(parsed.exitCode).toBe(128);
    }
  });

  test("rejects an ok verdict missing the pushed identity", () => {
    expect(
      KeeperRemoteResponseSchema.safeParse({ status: "ok", commitSha: "c".repeat(40) }).success,
    ).toBe(false);
  });

  test("rejects an unknown status discriminant", () => {
    expect(KeeperRemoteResponseSchema.safeParse({ status: "maybe" }).success).toBe(false);
  });
});
