import { describe, expect, test } from "bun:test";

import { createPullEtagStore, pullEtagStorePath } from "../../src/sync/pull-etag-store.ts";

const env = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

describe("pullEtagStorePath", () => {
  test("namespaces by a filesystem-safe (repo, domain) key under ~/.local/state/prx/sync", () => {
    expect(pullEtagStorePath("owner/repo/gh", "/home/u")).toBe(
      "/home/u/.local/state/prx/sync/owner_repo_gh/pull-etags.json",
    );
  });
});

describe("createPullEtagStore", () => {
  test("get/set in memory, then flush writes the whole map once", () => {
    const files = new Map<string, string>();
    let writes = 0;
    const store = createPullEtagStore("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: (p) => files.get(p),
      writeFile: (p, d) => {
        writes += 1;
        files.set(p, d);
      },
    });
    expect(store.get("o/r#1")).toBeUndefined();
    store.set("o/r#1", { etag: 'W/"a"', value: '{"status":"open"}' });
    store.set("o/r#2", { etag: 'W/"b"', value: '{"status":"closed"}' });
    expect(writes).toBe(0); // nothing written until flush
    store.flush();
    expect(writes).toBe(1); // one write for the whole map, not per-set

    const path = pullEtagStorePath("o/r/gh", "/home/u");
    const persisted = JSON.parse(files.get(path)!) as Record<string, unknown>;
    expect(persisted["o/r#1"]).toEqual({ etag: 'W/"a"', value: '{"status":"open"}' });
    expect(persisted["o/r#2"]).toEqual({ etag: 'W/"b"', value: '{"status":"closed"}' });
  });

  test("reloads a persisted map on construction", () => {
    const path = pullEtagStorePath("o/r/gh", "/home/u");
    const files = new Map<string, string>([
      [path, JSON.stringify({ "o/r#1": { etag: 'W/"a"', value: "v1" } })],
    ]);
    const store = createPullEtagStore("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: (p) => files.get(p),
      writeFile: (p, d) => void files.set(p, d),
    });
    expect(store.get("o/r#1")).toEqual({ etag: 'W/"a"', value: "v1" });
  });

  test("flush is a no-op when nothing changed (no redundant write)", () => {
    const path = pullEtagStorePath("o/r/gh", "/home/u");
    const files = new Map<string, string>([
      [path, JSON.stringify({ "o/r#1": { etag: 'W/"a"', value: "v1" } })],
    ]);
    let writes = 0;
    const store = createPullEtagStore("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: (p) => files.get(p),
      writeFile: () => void (writes += 1),
    });
    store.set("o/r#1", { etag: 'W/"a"', value: "v1" }); // identical ⇒ not dirty
    store.flush();
    expect(writes).toBe(0);
  });

  test("corrupt cache file ⇒ starts empty (a fresh fetch repopulates)", () => {
    const store = createPullEtagStore("o/r/gh", {
      env: env({ HOME: "/home/u" }),
      readFile: () => "{not json",
      writeFile: () => undefined,
    });
    expect(store.get("o/r#1")).toBeUndefined();
  });

  test("no HOME ⇒ no persistence (empty map, flush a no-op)", () => {
    let wrote = false;
    const store = createPullEtagStore("o/r/gh", {
      env: env({}),
      readFile: () => JSON.stringify({ "o/r#1": { etag: "x", value: "y" } }),
      writeFile: () => void (wrote = true),
    });
    expect(store.get("o/r#1")).toBeUndefined(); // didn't read the file
    store.set("o/r#1", { etag: "x", value: "y" });
    store.flush();
    expect(wrote).toBe(false);
  });
});
