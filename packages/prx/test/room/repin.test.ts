import { describe, expect, test } from "bun:test";

import { BOX_PINS, repinImage } from "../../src/room/repin.ts";

const D1 = "sha256:" + "a".repeat(64);
const D2 = "sha256:" + "b".repeat(64);

describe("repinImage", () => {
  test("replaces the digest for the matching image", () => {
    const text = `export const X = "ghcr.io/bounded-systems/prx/ghappd-box@${D1}";`;
    const out = repinImage(text, "ghcr.io/bounded-systems/prx/ghappd-box", D2);
    expect(out.changed).toBe(true);
    expect(out.text).toContain(`ghappd-box@${D2}`);
    expect(out.text).not.toContain(D1);
  });

  test("no-op when the digest already matches", () => {
    const text = `"ghcr.io/bounded-systems/prx/ghappd-box@${D2}"`;
    expect(repinImage(text, "ghcr.io/bounded-systems/prx/ghappd-box", D2).changed).toBe(false);
  });

  test("no-op when the image is absent (does not touch other images)", () => {
    const text = `"ghcr.io/bounded-systems/prx/beadsd-box@${D1}"`;
    const out = repinImage(text, "ghcr.io/bounded-systems/prx/ghappd-box", D2);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text); // beadsd-box pin untouched
  });

  test("rejects a non-sha256 digest (guards a bad skopeo read)", () => {
    expect(() => repinImage("x", "img", "latest")).toThrow(/digest/);
  });
});

describe("BOX_PINS", () => {
  test("each entry's file path looks like a room source under packages/prx", () => {
    for (const p of BOX_PINS) {
      expect(p.image).toMatch(/^ghcr\.io\/bounded-systems\/prx\/.+-box$/);
      expect(p.file).toMatch(/^packages\/prx\/src\/room\/.+\.ts$/);
    }
  });
});
