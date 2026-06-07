import { describe, expect, test } from "bun:test";

import { createPushWatermark, pushWatermarkPath } from "../../src/sync/push-watermark.ts";

const env = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

describe("pushWatermarkPath", () => {
  test("namespaces by a filesystem-safe (repo, domain) key under ~/.local/state/prx/sync", () => {
    expect(pushWatermarkPath("owner/repo/gh", "/home/u")).toBe(
      "/home/u/.local/state/prx/sync/owner_repo_gh/push-head",
    );
  });
});

describe("createPushWatermark", () => {
  test("read/write roundtrip through the injected fs", () => {
    const files = new Map<string, string>();
    const wm = createPushWatermark("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: (p) => files.get(p),
      writeFile: (p, d) => void files.set(p, d),
    });
    expect(wm.read()).toBeUndefined(); // nothing yet
    wm.write("head-abc");
    expect(wm.read()).toBe("head-abc");
    expect(files.get(pushWatermarkPath("o/r/gh", "/home/u"))).toBe("head-abc\n");
  });

  test("blank/whitespace file ⇒ undefined", () => {
    const wm = createPushWatermark("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: () => "  \n",
      writeFile: () => undefined,
    });
    expect(wm.read()).toBeUndefined();
  });

  test("no HOME ⇒ no persistence (read undefined, write a no-op)", () => {
    let wrote = false;
    const wm = createPushWatermark("o/r/gh", {
      env: env({}),
      readFile: () => "head-x",
      writeFile: () => void (wrote = true),
    });
    expect(wm.read()).toBeUndefined();
    wm.write("head-y");
    expect(wrote).toBe(false);
  });
});
