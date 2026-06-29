import { describe, expect, test } from "bun:test";

import {
  renderBdLifecycleArgs,
  runBdLifecycle,
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
