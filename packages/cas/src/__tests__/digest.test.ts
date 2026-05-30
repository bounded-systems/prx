import { describe, expect, test } from "bun:test";

import { sha256BareHex, sha256Hex } from "@bounded-systems/cas";
import type { Digest } from "@bounded-systems/cas";

describe("sha256Hex", () => {
  test("produces sha256:-prefixed hex digest", () => {
    const d = sha256Hex("hello");
    expect(String(d).startsWith("sha256:")).toBe(true);
    expect(String(d).slice("sha256:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns a branded Digest", () => {
    const d: Digest = sha256Hex("value");
    expect(typeof d).toBe("string");
  });

  test("stable across identical inputs", () => {
    expect(sha256Hex("same")).toBe(sha256Hex("same"));
  });
});

describe("sha256BareHex", () => {
  test("produces bare lowercase hex with no algorithm prefix", () => {
    const h = sha256BareHex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h.startsWith("sha256:")).toBe(false);
  });

  // The convergence guarantee scout's content-addressed reads rely on: the
  // prefixed Digest is exactly `sha256:` + the bare hex. One hashing
  // implementation, two presentations — so a bare-hex caller (scout) and a
  // prefixed-Digest caller (anchored-chain) can never disagree on the same
  // bytes.
  test("sha256Hex is sha256BareHex with the algorithm prefix", () => {
    for (const input of ["", "hello", "a longer string with spaces"]) {
      expect(String(sha256Hex(input))).toBe(`sha256:${sha256BareHex(input)}`);
    }
  });

  test("accepts byte input identically to string input of the same bytes", () => {
    expect(sha256BareHex(Buffer.from("hello"))).toBe(sha256BareHex("hello"));
  });
});
