// prx-82b 2e.2 — per-channel slack fetch cursor (file-based, no host bd). Pins
// channel validation + the file read/write round-trip + self-heal on absence.
import { describe, expect, test } from "bun:test";

import {
  getSlackWatermark,
  setSlackWatermark,
  slackWatermarkKey,
} from "../../src/fetch/slack-watermark.ts";
import { WatermarkError } from "../../src/fetch/watermark.ts";

const HOME = "/home/test";
const env = ((k: string) => (k === "HOME" ? HOME : undefined)) as never;

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

const path = (channel: string) =>
  `${HOME}/.local/state/prx/sync/slack/_repo/${channel}/watermark`;

describe("slackWatermarkKey", () => {
  test("derives the per-channel logical key", () => {
    expect(slackWatermarkKey("C123ABC")).toBe("prx.fetch.slack.C123ABC.watermark");
  });

  test("rejects a channel that could smuggle path separators", () => {
    expect(() => slackWatermarkKey("C1.evil")).toThrow(WatermarkError);
    expect(() => slackWatermarkKey("")).toThrow(WatermarkError);
    expect(() => slackWatermarkKey("a b")).toThrow(WatermarkError);
  });
});

describe("getSlackWatermark — file cursor (prx-82b 2e.2)", () => {
  test("returns the stored ts from the per-channel file", () => {
    const fs = fakeFs({ [path("C1")]: "1700000000.000100\n" });
    expect(getSlackWatermark("C1", { cwd: "/repo", env, readFile: fs.readFile }).ts).toBe(
      "1700000000.000100",
    );
  });

  test("absent cursor ⇒ null (self-healing)", () => {
    expect(getSlackWatermark("C1", { cwd: "/repo", env, readFile: fakeFs().readFile }).ts).toBeNull();
  });

  test("invalid channel throws WatermarkError", () => {
    expect(() => getSlackWatermark("a b", { cwd: "/repo", env })).toThrow(WatermarkError);
  });
});

describe("setSlackWatermark — file cursor", () => {
  test("writes the ts to the per-channel file; round-trips via get", () => {
    const fs = fakeFs();
    setSlackWatermark("C1", "1700000000.000200", { cwd: "/repo", env, writeFile: fs.writeFile });
    expect(fs.files.get(path("C1"))).toBe("1700000000.000200");
    expect(getSlackWatermark("C1", { cwd: "/repo", env, readFile: fs.readFile }).ts).toBe(
      "1700000000.000200",
    );
  });

  test("invalid channel throws WatermarkError", () => {
    expect(() => setSlackWatermark("a b", "1.0", { cwd: "/repo", env })).toThrow(WatermarkError);
  });
});
