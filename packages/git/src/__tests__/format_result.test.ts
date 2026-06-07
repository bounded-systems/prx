// formatGitExecResult — the plain/json renderer for a GitExecResult. Pure
// string shaping; covers the json branch and the plain branch's stderr-on-
// failure fallback.

import { describe, expect, test } from "bun:test";

import { formatGitExecResult, type GitExecResult } from "@bounded-systems/git";

const ok: GitExecResult = {
  exitCode: 0,
  stdout: "on branch main\n",
  stderr: "",
  policy: null,
};

const failed: GitExecResult = {
  exitCode: 1,
  stdout: "",
  stderr: "git-safe: fatal: not a repo\n",
  policy: null,
};

describe("formatGitExecResult", () => {
  test("json format pretty-prints the whole result", () => {
    const out = formatGitExecResult(ok, "json");
    expect(JSON.parse(out)).toEqual(ok);
  });

  test("plain format returns trimmed stdout on success", () => {
    expect(formatGitExecResult(ok, "plain")).toBe("on branch main");
  });

  test("plain format surfaces stderr when the command failed", () => {
    expect(formatGitExecResult(failed, "plain")).toBe("git-safe: fatal: not a repo");
  });

  test("plain format keeps stdout when stderr is present but exit is 0", () => {
    // stderr is only swapped in on a non-zero exit — a warning on stderr of a
    // successful command must not clobber the real stdout payload.
    const warn: GitExecResult = { exitCode: 0, stdout: "data", stderr: "warning", policy: null };
    expect(formatGitExecResult(warn, "plain")).toBe("data");
  });
});
