// GH-1172: tmux surface map handles mode-tagged session names without
// flagging plan + implement coexistence as a collision.

import { describe, test, expect } from "bun:test";

import {
  pickPrimaryTmuxEntry,
  readTmuxSurface,
  type TmuxSurfaceEntry,
} from "../../../src/pr-state/surfaces/tmux.ts";

function fakeRunner(stdout: string) {
  return () => ({ stdout, stderr: "", status: 0 });
}

describe("readTmuxSurface (GH-1172)", () => {
  test("parses an un-suffixed session name as mode=null (back-compat)", () => {
    const surface = readTmuxSurface(
      fakeRunner("gh_872_bpt\t/Users/dev/wt/gh_872_bpt\n"),
    );
    const entries = surface.get("GH-872")!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBeNull();
    expect(entries[0]!.conflicted).toBe(false);
  });

  test("parses a `-plan` suffix as mode=plan", () => {
    const surface = readTmuxSurface(
      fakeRunner("gh_1172_c5h-plan\t/Users/dev/wt/gh_1172_c5h\n"),
    );
    const entries = surface.get("GH-1172")!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe("plan");
  });

  test("plan + implement sessions for the same worktree are NOT conflicted", () => {
    const surface = readTmuxSurface(
      fakeRunner(
        [
          "gh_1172_c5h-plan\t/Users/dev/wt/gh_1172_c5h",
          "gh_1172_c5h-implement\t/Users/dev/wt/gh_1172_c5h",
        ].join("\n") + "\n",
      ),
    );
    const entries = surface.get("GH-1172")!;
    expect(entries).toHaveLength(2);
    const modes = entries.map((e) => e.mode).sort();
    expect(modes).toEqual(["implement", "plan"]);
    // Multi-mode coexistence is normal post-GH-1172, not a conflict.
    expect(entries.every((e) => e.conflicted === false)).toBe(true);
  });

  test("two sessions with the same (ticket, mode) pair flag conflicted", () => {
    // The original GH-872 collision case — two distinct paths sanitize to
    // the same session name. Mode-tagging doesn't change that semantic;
    // it just makes it rarer in practice.
    const surface = readTmuxSurface(
      fakeRunner(
        [
          "gh_1172_c5h-plan\t/Users/dev/wt/gh_1172_c5h",
          "gh_1172_c5h-plan\t/Users/dev/other/gh_1172_c5h",
        ].join("\n") + "\n",
      ),
    );
    const entries = surface.get("GH-1172")!;
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.conflicted === true)).toBe(true);
  });

  test("drops `main`, `mainx`, and unrelated sessions", () => {
    const surface = readTmuxSurface(
      fakeRunner(
        [
          "main\t/Users/dev/main",
          "mainx\t/Users/dev/mainx",
          "scratch\t/tmp/scratch",
          "gh_1172_c5h-plan\t/Users/dev/wt/gh_1172_c5h",
        ].join("\n") + "\n",
      ),
    );
    expect(surface.size).toBe(1);
    expect(surface.has("GH-1172")).toBe(true);
  });

  test("returns an empty map when tmux exits non-zero", () => {
    const failingRunner = () => ({ stdout: "", stderr: "no server", status: 1 });
    const surface = readTmuxSurface(failingRunner);
    expect(surface.size).toBe(0);
  });
});

describe("pickPrimaryTmuxEntry (GH-1172)", () => {
  function entry(mode: TmuxSurfaceEntry["mode"], name = "x"): TmuxSurfaceEntry {
    return { sessionName: name, sessionPath: "/p", mode, conflicted: false };
  }

  test("implement wins over plan when both are live", () => {
    const primary = pickPrimaryTmuxEntry([entry("plan", "p"), entry("implement", "i")]);
    expect(primary?.sessionName).toBe("i");
  });

  test("plan wins when implement is absent", () => {
    const primary = pickPrimaryTmuxEntry([entry("intake", "x"), entry("plan", "p")]);
    expect(primary?.sessionName).toBe("p");
  });

  test("falls through to un-suffixed entries last", () => {
    const primary = pickPrimaryTmuxEntry([entry(null, "u")]);
    expect(primary?.sessionName).toBe("u");
  });

  test("returns null on an empty list", () => {
    expect(pickPrimaryTmuxEntry([])).toBeNull();
  });
});
