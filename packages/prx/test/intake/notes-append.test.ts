import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  buildNotesAppendMarker,
  composeAppendedNotes,
  notesAlreadyContains,
} from "../../src/intake/notes-append.ts";

describe("buildNotesAppendMarker", () => {
  test("encodes verb and 8-hex sha256 prefix of the body", () => {
    const body = "follow-up note";
    const expected = createHash("sha256")
      .update(body, "utf8")
      .digest("hex")
      .slice(0, 8);
    const marker = buildNotesAppendMarker("prx-intake-comment", body);
    expect(marker).toBe(`[prx-intake-comment sha256-prefix=${expected}]`);
    expect(marker).toMatch(/^\[prx-intake-comment sha256-prefix=[0-9a-f]{8}\]$/);
  });

  test("merge verb has its own prefix", () => {
    const marker = buildNotesAppendMarker(
      "prx-intake-merge",
      "Merging into ai-home-abc",
    );
    expect(marker.startsWith("[prx-intake-merge sha256-prefix=")).toBe(true);
  });

  test("same (verb, body) yields the same marker (deterministic)", () => {
    const a = buildNotesAppendMarker("prx-intake-comment", "hello world");
    const b = buildNotesAppendMarker("prx-intake-comment", "hello world");
    expect(a).toBe(b);
  });

  test("different bodies under the same verb yield different markers", () => {
    const a = buildNotesAppendMarker("prx-intake-comment", "hello world");
    const b = buildNotesAppendMarker("prx-intake-comment", "goodbye world");
    expect(a).not.toBe(b);
  });
});

describe("notesAlreadyContains", () => {
  const marker = buildNotesAppendMarker("prx-intake-comment", "x");

  test("returns false for null / undefined / empty", () => {
    expect(notesAlreadyContains(null, marker)).toBe(false);
    expect(notesAlreadyContains(undefined, marker)).toBe(false);
    expect(notesAlreadyContains("", marker)).toBe(false);
  });

  test("returns true when marker appears as a substring", () => {
    expect(notesAlreadyContains(`leading\n${marker}\nbody`, marker)).toBe(true);
    expect(notesAlreadyContains(marker, marker)).toBe(true);
  });

  test("is case-sensitive (markers are lowercase hex)", () => {
    const upper = marker.toUpperCase();
    expect(notesAlreadyContains(upper, marker)).toBe(false);
  });

  test("returns false when only a different marker is present", () => {
    const other = buildNotesAppendMarker("prx-intake-comment", "different");
    expect(notesAlreadyContains(other, marker)).toBe(false);
  });
});

describe("composeAppendedNotes", () => {
  const marker = buildNotesAppendMarker("prx-intake-comment", "first note");

  test("first-write: null prior notes → no leading separator", () => {
    const result = composeAppendedNotes(null, marker, "first note");
    expect(result).toBe(`${marker}\nfirst note`);
  });

  test("first-write: empty prior notes treated identically to null", () => {
    const result = composeAppendedNotes("", marker, "first note");
    expect(result).toBe(`${marker}\nfirst note`);
  });

  test("first-write: undefined prior notes treated identically to null", () => {
    const result = composeAppendedNotes(undefined, marker, "first note");
    expect(result).toBe(`${marker}\nfirst note`);
  });

  test("append: prior notes get a blank-line separator before the new entry", () => {
    const prior = "earlier hand-written note";
    const result = composeAppendedNotes(prior, marker, "first note");
    expect(result).toBe(`${prior}\n\n${marker}\nfirst note`);
  });

  test("append preserves the entire prior notes value verbatim", () => {
    const prior = "line a\nline b\n\nline c";
    const result = composeAppendedNotes(prior, marker, "body");
    expect(result.startsWith(`${prior}\n\n`)).toBe(true);
    expect(result.endsWith(`${marker}\nbody`)).toBe(true);
  });
});
