import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { PodSpecSchema } from "../../src/room/pod.ts";
import { RoomSpecSchema } from "../../src/room/spec.ts";
import {
  declaredSecrets,
  ensurePodSecrets,
  parseSource,
  type SecretSource,
} from "../../src/room/pod-secrets.ts";
import type { PodmanRun } from "../../src/room/podman-runtime.ts";

type RoomInput = z.input<typeof RoomSpecSchema>;
const pod = (rooms: RoomInput[]) =>
  PodSpecSchema.parse({ name: "p", executor: { name: "h" }, rooms });

const keeper: RoomInput = {
  name: "keeperd-room",
  secrets: [{ name: "prx-keeper-key", target: "/run/secrets/keeper-key" }],
};
const forge: RoomInput = {
  name: "forge-d-room",
  secrets: [
    { name: "prx-forge-key", target: "/run/secrets/forge-key" },
    { name: "prx-forge-id", target: "/run/secrets/forge-id" },
  ],
};

// Fake podman: `secret ls` returns `existing`; everything else succeeds. Records
// every argv + stdin so we can assert how secrets are created (path vs stdin).
function fakePodman(existing: string[]) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: PodmanRun = (args, input) => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (args[0] === "secret" && args[1] === "ls") {
      return { status: 0, stdout: existing.join("\n"), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("declaredSecrets", () => {
  test("flattens every room's declared secrets, tagged with the room", () => {
    expect(declaredSecrets(pod([keeper, forge]))).toEqual([
      { name: "prx-keeper-key", target: "/run/secrets/keeper-key", room: "keeperd-room" },
      { name: "prx-forge-key", target: "/run/secrets/forge-key", room: "forge-d-room" },
      { name: "prx-forge-id", target: "/run/secrets/forge-id", room: "forge-d-room" },
    ]);
  });

  test("a room with no secrets contributes nothing", () => {
    expect(declaredSecrets(pod([{ name: "claude-room" }]))).toEqual([]);
  });
});

describe("parseSource", () => {
  test("@-prefix is a file path (stripped); otherwise a literal", () => {
    expect(parseSource("@/k.pem")).toEqual({ kind: "file", path: "/k.pem" });
    expect(parseSource("4169313")).toEqual({ kind: "literal", value: "4169313" });
  });
});

describe("ensurePodSecrets", () => {
  test("existing secret without --replace is left alone (no create call)", () => {
    const { run, calls } = fakePodman(["prx-forge-id"]);
    const out = ensurePodSecrets(
      pod([forge]),
      new Map([["prx-forge-id", { kind: "literal", value: "x" } as SecretSource]]),
      { run },
    );
    expect(out.find((s) => s.name === "prx-forge-id")).toMatchObject({
      action: "exists",
      present: true,
    });
    expect(calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  test("declared secret with no source → missing-source (never silently skipped)", () => {
    const { run } = fakePodman([]);
    const out = ensurePodSecrets(pod([forge]), new Map(), { run });
    expect(out.every((s) => s.action === "missing-source")).toBe(true);
  });

  test("file source hands podman the PATH (secret never enters prx)", () => {
    const { run, calls } = fakePodman([]);
    const out = ensurePodSecrets(
      pod([forge]),
      new Map([["prx-forge-key", { kind: "file", path: "/k.pem" } as SecretSource]]),
      { run },
    );
    expect(out.find((s) => s.name === "prx-forge-key")?.action).toBe("created");
    const create = calls.find((c) => c.args.includes("create") && c.args.includes("prx-forge-key"));
    expect(create?.args).toEqual(["secret", "create", "prx-forge-key", "/k.pem"]);
    expect(create?.input).toBeUndefined(); // PEM not piped through prx
  });

  test("literal source is piped via stdin", () => {
    const { run, calls } = fakePodman([]);
    ensurePodSecrets(
      pod([forge]),
      new Map([["prx-forge-id", { kind: "literal", value: "4169313" } as SecretSource]]),
      { run },
    );
    const create = calls.find((c) => c.args.includes("prx-forge-id") && c.args.includes("create"));
    expect(create?.args).toEqual(["secret", "create", "prx-forge-id", "-"]);
    expect(create?.input).toBe("4169313");
  });

  test("--replace rotates: rm then create", () => {
    const { run, calls } = fakePodman(["prx-forge-id"]);
    const out = ensurePodSecrets(
      pod([forge]),
      new Map([["prx-forge-id", { kind: "literal", value: "9" } as SecretSource]]),
      { run, replace: true },
    );
    expect(out.find((s) => s.name === "prx-forge-id")?.action).toBe("replaced");
    const order = calls.filter((c) => c.args.includes("prx-forge-id")).map((c) => c.args[1]);
    expect(order).toEqual(["rm", "create"]);
  });
});
