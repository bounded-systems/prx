// prx-82b 2e.2 — unit tests for the file-based gh-issues fetch cursor.
//
// The cursor is local-first, self-healing state (host-local file, like git-ai /
// the sync agent's push-watermark): absent ⇒ `{ since: null }` ⇒ full re-fetch,
// never an error. No host bd. Drives a fake fs (path→content map) + a fake env.

import { describe, expect, test } from "bun:test";

import { getLastPoints, getWatermark, setWatermark } from "../../src/fetch/watermark.ts";

const HOME = "/home/test";
const env = ((k: string) => (k === "HOME" ? HOME : undefined)) as never;

/** A fake fs (path → content); `readFile` throws ENOENT-style when absent. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile: (p: string): string => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p: string, data: string): void => {
      files.set(p, data);
    },
  };
}

const WM = `${HOME}/.local/state/prx/sync/gh-issues/_tmp/watermark`;
const LP = `${HOME}/.local/state/prx/sync/gh-issues/_tmp/last-points`;

describe("getWatermark — file cursor (prx-82b 2e.2)", () => {
  test("returns the trimmed value when the cursor file exists", () => {
    const fs = fakeFs({ [WM]: "2026-05-12T00:00:00Z\n" });
    expect(getWatermark({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({
      since: "2026-05-12T00:00:00Z",
    });
  });

  test("absent cursor ⇒ { since: null } (self-healing, never throws)", () => {
    const fs = fakeFs();
    expect(getWatermark({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({ since: null });
  });

  test("empty cursor file ⇒ { since: null }", () => {
    const fs = fakeFs({ [WM]: "   \n" });
    expect(getWatermark({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({ since: null });
  });

  test("no HOME ⇒ { since: null } (no persistence)", () => {
    const noHome = ((_k: string) => undefined) as never;
    expect(getWatermark({ cwd: "/tmp", env: noHome })).toEqual({ since: null });
  });
});

describe("setWatermark — file cursor", () => {
  test("writes the cursor, and getWatermark reads it back (round-trip)", () => {
    const fs = fakeFs();
    setWatermark({ cwd: "/tmp", env, writeFile: fs.writeFile }, "2026-06-01T00:00:00Z");
    expect(fs.files.get(WM)).toBe("2026-06-01T00:00:00Z");
    expect(getWatermark({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({
      since: "2026-06-01T00:00:00Z",
    });
  });

  test("no HOME ⇒ a no-op (best-effort persistence)", () => {
    const noHome = ((_k: string) => undefined) as never;
    const fs = fakeFs();
    setWatermark({ cwd: "/tmp", env: noHome, writeFile: fs.writeFile }, "x");
    expect(fs.files.size).toBe(0);
  });

  test("swallows a write error (best-effort; a lost cursor self-heals)", () => {
    const writeFile = () => {
      throw new Error("EACCES");
    };
    expect(() => setWatermark({ cwd: "/tmp", env, writeFile }, "x")).not.toThrow();
  });
});

describe("getLastPoints — file cursor (GH-1257)", () => {
  test("parses an integer cursor into { points: n }", () => {
    const fs = fakeFs({ [LP]: "42\n" });
    expect(getLastPoints({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({ points: 42 });
  });

  test("absent ⇒ { points: null }", () => {
    expect(getLastPoints({ cwd: "/tmp", env, readFile: fakeFs().readFile })).toEqual({
      points: null,
    });
  });

  test("non-integer ⇒ { points: null }", () => {
    const fs = fakeFs({ [LP]: "abc\n" });
    expect(getLastPoints({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({ points: null });
  });

  test("negative ⇒ { points: null }", () => {
    const fs = fakeFs({ [LP]: "-3\n" });
    expect(getLastPoints({ cwd: "/tmp", env, readFile: fs.readFile })).toEqual({ points: null });
  });
});
