import { describe, expect, test } from "bun:test";

import {
  renderBdLifecycleArgs,
  runBdLifecycle,
  DOLT_CREDS_SECRET,
} from "../../src/room/lifecycle-runner.ts";
import { BEADSD_ROOM_IMAGE } from "../../src/room/beadsd-room.ts";
import type { PodmanRunResult } from "../../src/room/podman-runtime.ts";

describe("renderBdLifecycleArgs — ephemeral lifecycle op (prx-82b Slice 2c)", () => {
  test("renders a one-shot `bd` run bound to the repo at /work", () => {
    const argv = renderBdLifecycleArgs({ repo: "/abs/repo", args: ["init", "--prefix", "x"] });
    expect(argv).toEqual([
      "run",
      "--rm",
      "--userns",
      "keep-id",
      "-e",
      "HOME=/tmp",
      "-v",
      "/abs/repo:/work",
      "-w",
      "/work",
      "--entrypoint",
      "bd",
      BEADSD_ROOM_IMAGE,
      "init",
      "--prefix",
      "x",
    ]);
  });

  test("`bin` overrides the entrypoint (e.g. raw dolt) and `image` overrides the box", () => {
    const argv = renderBdLifecycleArgs({
      repo: "/r",
      bin: "dolt",
      image: "ghcr.io/x/box@sha256:deadbeef",
      args: ["clone", "owner/db"],
    });
    expect(argv).toContain("dolt");
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("dolt");
    expect(argv).toContain("ghcr.io/x/box@sha256:deadbeef");
    expect(argv.slice(-2)).toEqual(["clone", "owner/db"]);
  });

  test("keep-id + the /work bind are always present (host-owned writes)", () => {
    const argv = renderBdLifecycleArgs({ repo: "/r", args: ["migrate"] });
    expect(argv).toContain("--rm");
    expect(argv[argv.indexOf("--userns") + 1]).toBe("keep-id");
    expect(argv).toContain("/r:/work");
  });

  test("no commonDir mount by default (self-contained checkout)", () => {
    const argv = renderBdLifecycleArgs({ repo: "/r", args: ["init"] });
    expect(argv.filter((a) => a === "-v")).toHaveLength(1); // only the /work bind
  });

  test("commonDir renders an identity-mapped mount (linked worktree's bare repo)", () => {
    const argv = renderBdLifecycleArgs({
      repo: "/worktrees/lima-devshell/mainx",
      commonDir: "/bare/lima-devshell.git",
      args: ["init"],
    });
    expect(argv).toContain("/bare/lima-devshell.git:/bare/lima-devshell.git");
    expect(argv).toContain("/worktrees/lima-devshell/mainx:/work");
    // commonDir mount precedes the /work bind; both precede -w/--entrypoint.
    expect(argv.indexOf("/bare/lima-devshell.git:/bare/lima-devshell.git")).toBeLessThan(
      argv.indexOf("/worktrees/lima-devshell/mainx:/work"),
    );
  });
});

describe("runBdLifecycle", () => {
  test("spawns podman with the rendered argv and returns its result", () => {
    let seen: string[] | undefined;
    const fakeRun = (args: string[]): PodmanRunResult => {
      seen = args;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const res = runBdLifecycle({ repo: "/r", args: ["config", "set", "k", "v"] }, fakeRun);
    expect(res).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(seen).toEqual(renderBdLifecycleArgs({ repo: "/r", args: ["config", "set", "k", "v"] }));
  });
});

describe("renderBdLifecycleArgs — room-style secret mounts (prx-82b 2c.4)", () => {
  test("renders --secret name,target=path the same way rooms do", () => {
    const argv = renderBdLifecycleArgs({
      repo: "/r",
      args: ["dolt", "push", "origin", "main"],
      secrets: [DOLT_CREDS_SECRET],
    });
    const i = argv.indexOf("--secret");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("prx-dolt-creds,target=/run/secrets/dolt-creds");
    // secrets precede the volume + image; the op args stay last.
    expect(argv.slice(-4)).toEqual(["dolt", "push", "origin", "main"]);
  });

  test("multiple secrets each render a --secret flag; none by default", () => {
    const none = renderBdLifecycleArgs({ repo: "/r", args: ["init"] });
    expect(none).not.toContain("--secret");
    const two = renderBdLifecycleArgs({
      repo: "/r",
      args: ["x"],
      secrets: [
        { name: "a", target: "/run/secrets/a" },
        { name: "b", target: "/run/secrets/b" },
      ],
    });
    expect(two.filter((x) => x === "--secret")).toHaveLength(2);
  });

  test("DOLT_CREDS_SECRET is a room-shaped secret (provisioned like the others)", () => {
    expect(DOLT_CREDS_SECRET).toEqual({ name: "prx-dolt-creds", target: "/run/secrets/dolt-creds" });
  });
});
