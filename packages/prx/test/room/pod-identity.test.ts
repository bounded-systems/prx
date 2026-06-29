import { describe, expect, test } from "bun:test";

import { podFor, LEGACY_POD_NAME } from "../../src/room/pod-identity.ts";
import { perRepoPodFor, perRepoPod } from "../../src/room/per-repo-pod.ts";
import { DEFAULT_DOOR_DIR } from "../../src/room/pod.ts";

describe("podFor — per-repo pod identity (prx-82b Slice 2a)", () => {
  test("a registered repo gets a per-repo name + door dir keyed by its slug", () => {
    const id = podFor("/work/some-repo", () => "io_github_bounded_systems_prx");
    expect(id.slug).toBe("io_github_bounded_systems_prx");
    expect(id.name).toBe("prx-io_github_bounded_systems_prx");
    expect(id.doorDir).toBe(`${DEFAULT_DOOR_DIR}/io_github_bounded_systems_prx`);
  });

  test("an unregistered cwd falls back to the legacy singleton (back-compat)", () => {
    const id = podFor("/somewhere/unregistered", () => null);
    expect(id.slug).toBeNull();
    expect(id.name).toBe(LEGACY_POD_NAME);
    expect(id.doorDir).toBe(DEFAULT_DOOR_DIR);
  });

  test("two repos resolve to distinct pods + distinct door dirs (no collision)", () => {
    const a = podFor("/work/a", () => "owner_a");
    const b = podFor("/work/b", () => "owner_b");
    expect(a.name).not.toBe(b.name);
    expect(a.doorDir).not.toBe(b.doorDir);
  });
});

describe("perRepoPodFor — the per-repo PodSpec", () => {
  test("overrides name/doorDir/repo from the resolved identity, keeps the fleet", () => {
    const spec = perRepoPodFor("/work/myrepo", () => "owner_myrepo");
    expect(spec.name).toBe("prx-owner_myrepo");
    expect(spec.doorDir).toBe(`${DEFAULT_DOOR_DIR}/owner_myrepo`);
    expect(spec.repo).toBe("/work/myrepo");
    // Same fleet as the static template — only identity changes.
    expect(spec.rooms).toEqual(perRepoPod.rooms);
    expect(spec.services).toEqual(perRepoPod.services);
    expect(spec.executor).toEqual(perRepoPod.executor);
  });

  test("unregistered cwd → the legacy singleton spec (name prx-pod, default door dir)", () => {
    const spec = perRepoPodFor("/tmp/nope", () => null);
    expect(spec.name).toBe(LEGACY_POD_NAME);
    expect(spec.doorDir).toBe(DEFAULT_DOOR_DIR);
    expect(spec.repo).toBe("/tmp/nope");
  });
});
