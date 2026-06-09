// prx-agd — per-channel slack watermark. Fakes the bd-config spawn seam; no
// real bd. Pins key derivation, both bd "absent" modes → null, and the
// read/write round-trip.
import { describe, expect, test } from "bun:test";

import {
  getSlackWatermark,
  setSlackWatermark,
  slackWatermarkKey,
} from "../../src/fetch/slack-watermark.ts";
import { WatermarkError, type SpawnResult } from "../../src/fetch/watermark.ts";

type Call = { cmd: string[]; cwd?: string | undefined };

function runner(reply: (cmd: string[]) => SpawnResult) {
  const calls: Call[] = [];
  const run = (cmd: string[], options?: { cwd?: string }) => {
    calls.push({ cmd, cwd: options?.cwd });
    return reply(cmd);
  };
  return { run, calls };
}

const ok = (stdout: string): SpawnResult => ({ stdout, stderr: "", status: 0 });

describe("slackWatermarkKey", () => {
  test("derives the per-channel dotted key", () => {
    expect(slackWatermarkKey("C123ABC")).toBe("prx.fetch.slack.C123ABC.watermark");
  });

  test("rejects a channel that could smuggle key separators", () => {
    expect(() => slackWatermarkKey("C1.evil")).toThrow(WatermarkError);
    expect(() => slackWatermarkKey("")).toThrow(WatermarkError);
    expect(() => slackWatermarkKey("a b")).toThrow(WatermarkError);
  });
});

describe("getSlackWatermark", () => {
  test("returns the stored ts", () => {
    const { run, calls } = runner(() => ok("1700000000.000100\n"));
    const r = getSlackWatermark("C1", { cwd: "/repo", runner: run });
    expect(r.ts).toBe("1700000000.000100");
    expect(calls[0]!.cmd).toEqual(["bd", "config", "get", "prx.fetch.slack.C1.watermark"]);
    expect(calls[0]!.cwd).toBe("/repo");
  });

  test("exit-0 '(not set)' sentinel coerces to null", () => {
    const { run } = runner(() => ok("prx.fetch.slack.C1.watermark (not set)\n"));
    expect(getSlackWatermark("C1", { cwd: "/repo", runner: run }).ts).toBeNull();
  });

  test("legacy exit-1 'not set' on stderr coerces to null", () => {
    const { run } = runner(() => ({ stdout: "", stderr: "config key not set", status: 1 }));
    expect(getSlackWatermark("C1", { cwd: "/repo", runner: run }).ts).toBeNull();
  });

  test("an unexpected spawn failure throws WatermarkError", () => {
    const { run } = runner(() => ({ stdout: "", stderr: "permission denied", status: 1 }));
    expect(() => getSlackWatermark("C1", { cwd: "/repo", runner: run })).toThrow(WatermarkError);
  });
});

describe("setSlackWatermark", () => {
  test("writes the ts under the per-channel key", () => {
    const { run, calls } = runner(() => ok(""));
    setSlackWatermark("C1", "1700000000.000200", { cwd: "/repo", runner: run });
    expect(calls[0]!.cmd).toEqual([
      "bd",
      "config",
      "set",
      "prx.fetch.slack.C1.watermark",
      "1700000000.000200",
    ]);
  });

  test("a non-zero exit throws WatermarkError", () => {
    const { run } = runner(() => ({ stdout: "", stderr: "boom", status: 1 }));
    expect(() => setSlackWatermark("C1", "1.0", { cwd: "/repo", runner: run })).toThrow(
      WatermarkError,
    );
  });
});
