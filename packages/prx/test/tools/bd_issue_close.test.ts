// GH-1773: narrow `bd close` wrapper — bypasses the policy gate the same
// way gh_issue_close.ts does for `gh close`. Invoked only by
// `prx submit postmerge` to action `Refs <bd-id>` lines on merge.

import { describe, expect, test } from "bun:test";
import {
  buildBdIssueCloseArgs,
  execBdIssueClose,
  formatBdIssueCloseResult,
  type BdIssueCloseSpawn,
} from "../../src/tools/bd_issue_close.ts";

describe("buildBdIssueCloseArgs", () => {
  test("emits close/<id> with no reason by default", () => {
    expect(buildBdIssueCloseArgs({ id: "BD-deadbeef" })).toEqual([
      "close",
      "BD-deadbeef",
    ]);
  });

  test("forwards explicit --reason", () => {
    expect(
      buildBdIssueCloseArgs({ id: "BD-deadbeef", reason: "completed" }),
    ).toEqual(["close", "BD-deadbeef", "--reason", "completed"]);
  });
});

describe("execBdIssueClose", () => {
  test("captures stdout/stderr and exit 0 on success", () => {
    const spawn: BdIssueCloseSpawn = (file, args) => {
      // GH-296: routed through the daemon — `prx beads close <id>`.
      expect(file).toBe("prx");
      expect(args[0]).toBe("beads");
      expect(args[1]).toBe("close");
      expect(args[2]).toBe("BD-deadbeef");
      return {
        status: 0,
        stdout: "closed BD-deadbeef\n",
        stderr: "",
      };
    };
    const result = execBdIssueClose(
      { id: "BD-deadbeef" },
      { HOME: "/tmp" },
      spawn,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("closed BD-deadbeef\n");
    expect(result.stderr).toBe("");
  });

  test("propagates non-zero exit and stderr from bd", () => {
    const spawn: BdIssueCloseSpawn = () => ({
      status: 2,
      stdout: "",
      stderr: "bd: not found\n",
    });
    const result = execBdIssueClose(
      { id: "BD-deadbeef" },
      { HOME: "/tmp" },
      spawn,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("bd: not found\n");
  });

  test("status null is normalized to exit 1", () => {
    const spawn: BdIssueCloseSpawn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });
    const result = execBdIssueClose(
      { id: "BD-deadbeef" },
      { HOME: "/tmp" },
      spawn,
    );
    expect(result.exitCode).toBe(1);
  });

  test("strips BEADS_DIR from child env so cwd determines workspace", () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const spawn: BdIssueCloseSpawn = (_file, _args, options) => {
      observedEnv = options.env;
      return { status: 0, stdout: "", stderr: "" };
    };
    execBdIssueClose(
      { id: "BD-deadbeef", cwd: "/tmp/ws" },
      { HOME: "/tmp", BEADS_DIR: "/wrong/workspace" },
      spawn,
    );
    expect(observedEnv?.BEADS_DIR).toBeUndefined();
    expect(observedEnv?.HOME).toBe("/tmp");
  });
});

describe("formatBdIssueCloseResult", () => {
  test("plain success returns trimmed stdout", () => {
    expect(
      formatBdIssueCloseResult(
        { exitCode: 0, stdout: "closed BD-deadbeef\n", stderr: "" },
        "plain",
      ),
    ).toBe("closed BD-deadbeef");
  });

  test("plain failure returns stderr", () => {
    expect(
      formatBdIssueCloseResult(
        { exitCode: 1, stdout: "", stderr: "boom\n" },
        "plain",
      ),
    ).toBe("boom");
  });

  test("json format is valid JSON", () => {
    const json = JSON.parse(
      formatBdIssueCloseResult(
        { exitCode: 0, stdout: "ok", stderr: "" },
        "json",
      ),
    ) as { exitCode: number; stdout: string };
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toBe("ok");
  });
});
