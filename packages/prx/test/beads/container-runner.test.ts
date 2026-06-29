import { describe, expect, test } from "bun:test";

import { containerBdRunner, containerRepoRunner } from "../../src/beads/container-runner.ts";
import { renderBdLifecycleArgs } from "../../src/room/lifecycle-runner.ts";
import type { PodmanRunResult } from "../../src/room/podman-runtime.ts";

describe("containerBdRunner — bd lifecycle ops in an ephemeral container (prx-82b 2c.2)", () => {
  test("maps cmd[0]→entrypoint, cwd→/work, and the podman result→SpawnCaptureResult", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const runner = containerBdRunner(run);
    const res = runner(["bd", "init", "--non-interactive", "--prefix=x"], { cwd: "/abs/repo" });

    // The bd op ran in the container against the repo bind.
    expect(seen).toEqual(
      renderBdLifecycleArgs({ repo: "/abs/repo", bin: "bd", args: ["init", "--non-interactive", "--prefix=x"] }),
    );
    // Adapted to the BdInitRunner/BdMigrateRunner result shape.
    expect(res).toEqual({ status: 0, signal: null, stdout: "ok", stderr: "" });
  });

  test("a non-zero container exit maps to a capture failure (status preserved)", () => {
    const run = (): PodmanRunResult => ({ status: 1, stdout: "", stderr: "boom" });
    const res = containerBdRunner(run)(["bd", "migrate"], { cwd: "/r" });
    expect(res.status).toBe(1);
    expect(res.stderr).toBe("boom");
    expect(res.signal).toBeNull();
  });

  test("the host-bd env/homeOverride arg is ignored (clean container fs makes it moot)", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    containerBdRunner(run)(["bd", "config", "set", "k", "v"], {
      cwd: "/r",
      env: { HOME: "/some/host/tmp" },
    });
    // No host HOME leaks into the podman argv — the runner sets HOME=/tmp itself.
    expect(seen).not.toContain("/some/host/tmp");
    expect(seen?.[seen.indexOf("-e") + 1]).toBe("HOME=/tmp");
  });
});

describe("containerRepoRunner — RepoRunner-shaped (bd dolt remote add)", () => {
  test("runs the dolt op in-container and returns {stdout,stderr,status:number}", () => {
    let seen: string[] | undefined;
    const run = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "added", stderr: "" };
    };
    const res = containerRepoRunner(run)(["bd", "dolt", "remote", "add", "origin", "u"], { cwd: "/r" });
    expect(seen).toEqual(
      renderBdLifecycleArgs({ repo: "/r", bin: "bd", args: ["dolt", "remote", "add", "origin", "u"] }),
    );
    expect(res).toEqual({ stdout: "added", stderr: "", status: 0 });
  });

  test("a null podman status maps to 1 (RepoRunner wants a number)", () => {
    const run = (): PodmanRunResult => ({ status: null, stdout: "", stderr: "x" });
    expect(containerRepoRunner(run)(["bd", "dolt", "remote", "add"], { cwd: "/r" }).status).toBe(1);
  });
});
