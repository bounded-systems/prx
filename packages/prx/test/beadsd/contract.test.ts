import { describe, expect, test } from "bun:test";

import {
  BEADS_READ_KINDS,
  BEADS_REQUEST_KINDS,
  BEADS_WRITE_KINDS,
  BeadsRequestSchema,
  BeadsResponseSchema,
  isBeadsWriteKind,
} from "../../src/beadsd/contract.ts";

describe("beadsd wire contract — request envelope", () => {
  test("the envelope is an enumerable read+write allowlist", () => {
    expect(BEADS_READ_KINDS).toEqual(["ready", "list", "show", "children", "recall", "memories"]);
    expect(BEADS_WRITE_KINDS).toEqual(["create", "update", "close", "reopen", "dep", "remember"]);
    expect(BEADS_REQUEST_KINDS).toEqual([
      "ready", "list", "show", "children", "recall", "memories",
      "create", "update", "close", "reopen", "dep", "remember",
    ]);
  });

  test("accepts the dep write envelope (GH-296)", () => {
    expect(
      BeadsRequestSchema.safeParse({ kind: "dep", action: "add", from: "a", to: "b", depType: "parent-child" }).success,
    ).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "dep", action: "remove", from: "a", to: "b" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "dep", action: "bogus", from: "a", to: "b" }).success).toBe(false);
    expect(BeadsRequestSchema.safeParse({ kind: "dep", action: "add", from: "a" }).success).toBe(false);
  });

  test("accepts the children read envelope and classifies it as a read (prx-zbsi)", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "children", id: "prx-epic" }).success).toBe(true);
    // id is required (min 1).
    expect(BeadsRequestSchema.safeParse({ kind: "children" }).success).toBe(false);
    expect(BeadsRequestSchema.safeParse({ kind: "children", id: "" }).success).toBe(false);
    expect(isBeadsWriteKind("children")).toBe(false);
  });

  test("accepts the memory surface envelopes; classifies remember as a write, recall/memories as reads (prx-44y)", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "remember", key: "handoff/a", body: "{}" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "recall", key: "handoff/a" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "memories", prefix: "handoff/" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "memories" }).success).toBe(true); // prefix optional
    // required fields
    expect(BeadsRequestSchema.safeParse({ kind: "remember", key: "k" }).success).toBe(false); // no body
    expect(BeadsRequestSchema.safeParse({ kind: "recall" }).success).toBe(false); // no key
    expect(isBeadsWriteKind("remember")).toBe(true);
    expect(isBeadsWriteKind("recall")).toBe(false);
    expect(isBeadsWriteKind("memories")).toBe(false);
  });

  test("isBeadsWriteKind classifies reads vs writes", () => {
    expect(isBeadsWriteKind("show")).toBe(false);
    expect(isBeadsWriteKind("create")).toBe(true);
    expect(isBeadsWriteKind("close")).toBe(true);
  });

  test("accepts ready, list (±status), and show", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "ready" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list", status: "open" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "show", id: "GH-228" }).success).toBe(true);
  });

  test("accepts the read-parity flags (ready --explain, list --all/--limit)", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "ready", explain: true }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list", all: true }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "list", all: true, limit: 0 }).success).toBe(true);
    // a negative limit is rejected
    expect(BeadsRequestSchema.safeParse({ kind: "list", limit: -1 }).success).toBe(false);
  });

  test("accepts the write envelope (create / update / close)", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "create", issueType: "task", title: "x" }).success).toBe(true);
    expect(
      BeadsRequestSchema.safeParse({ kind: "create", issueType: "bug", title: "x", priority: 1, description: "d" })
        .success,
    ).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "update", id: "prx-abb", status: "in_progress" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "update", id: "prx-abb", assignee: "" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "close", id: "prx-abb", reason: "done" }).success).toBe(true);
  });

  test("accepts the wave-2 write parity fields (create --external-ref/--silent, update --type)", () => {
    expect(
      BeadsRequestSchema.safeParse({
        kind: "create",
        issueType: "task",
        title: "x",
        externalRef: "https://github.com/o/r/issues/1",
        silent: true,
      }).success,
    ).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "update", id: "prx-abb", issueType: "bug" }).success).toBe(true);
  });

  test("accepts update --title / --description (GH-296)", () => {
    expect(
      BeadsRequestSchema.safeParse({ kind: "update", id: "prx-abb", title: "t", description: "d" }).success,
    ).toBe(true);
  });

  test("accepts update --external-ref / --notes (GH-296 write parity)", () => {
    expect(
      BeadsRequestSchema.safeParse({
        kind: "update",
        id: "prx-abb",
        externalRef: "https://github.com/o/r/issues/9",
        notes: "linked by mirror",
      }).success,
    ).toBe(true);
  });

  test("accepts the reopen envelope", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "reopen", id: "prx-abb" }).success).toBe(true);
    expect(BeadsRequestSchema.safeParse({ kind: "reopen" }).success).toBe(false); // no id
    expect(isBeadsWriteKind("reopen")).toBe(true);
  });

  test("rejects malformed requests", () => {
    expect(BeadsRequestSchema.safeParse({ kind: "show" }).success).toBe(false);
    expect(BeadsRequestSchema.safeParse({ kind: "list", status: "" }).success).toBe(false);
    expect(BeadsRequestSchema.safeParse({ kind: "create", title: "x" }).success).toBe(false); // no issueType
    expect(BeadsRequestSchema.safeParse({ kind: "create", issueType: "task" }).success).toBe(false); // no title
    expect(BeadsRequestSchema.safeParse({ kind: "create", issueType: "task", title: "x", priority: 9 }).success).toBe(
      false,
    ); // priority out of range
    expect(BeadsRequestSchema.safeParse({ kind: "close" }).success).toBe(false); // no id
    expect(BeadsRequestSchema.safeParse({ kind: "frobnicate" }).success).toBe(false); // off-envelope
  });
});

describe("beadsd wire contract — response", () => {
  test("accepts an ok verdict carrying a (opaque) result", () => {
    const parsed = BeadsResponseSchema.parse({ status: "ok", result: [{ id: "GH-228" }] });
    expect(parsed.status).toBe("ok");
  });

  test("accepts an ok verdict with an etag (dataset generation)", () => {
    const parsed = BeadsResponseSchema.parse({ status: "ok", result: [], etag: "uoev8kinb09rfg" });
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.etag).toBe("uoev8kinb09rfg");
  });

  test("accepts an error verdict with code + message", () => {
    const parsed = BeadsResponseSchema.parse({ status: "error", code: "not-found", message: "no such id" });
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") expect(parsed.code).toBe("not-found");
  });

  test("rejects an error verdict missing the code", () => {
    expect(BeadsResponseSchema.safeParse({ status: "error", message: "x" }).success).toBe(false);
  });

  test("rejects an unknown status discriminant", () => {
    expect(BeadsResponseSchema.safeParse({ status: "maybe" }).success).toBe(false);
  });
});
