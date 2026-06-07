// GH-352: resolveMasterSource — which master `prx provenance status` reports.
import { describe, expect, test } from "bun:test";

import { resolveMasterSource } from "../config.ts";

const noRead = (): string => {
  throw new Error("unexpected read");
};

describe("resolveMasterSource", () => {
  test("PRX_PROVENANCE_MASTER_FILE that exists ⇒ operator-file (env wins)", () => {
    const env = (k: string) => (k === "PRX_PROVENANCE_MASTER_FILE" ? "/run/secret/master" : undefined);
    expect(resolveMasterSource(env, noRead, (p) => p === "/run/secret/master")).toEqual({
      source: "operator-file",
      path: "/run/secret/master",
    });
  });

  test("no env file, but config.masterFile exists ⇒ config-file", () => {
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    const read = (p: string) =>
      p === "/home/u/.config/prx/config.json"
        ? JSON.stringify({ provenance: { masterFile: "/cfg/master" } })
        : noRead();
    const exists = (p: string) => p === "/home/u/.config/prx/config.json" || p === "/cfg/master";
    expect(resolveMasterSource(env, read, exists)).toEqual({ source: "config-file", path: "/cfg/master" });
  });

  test("env file configured but missing ⇒ falls through (here to dev-bootstrap)", () => {
    const env = (k: string) =>
      k === "PRX_PROVENANCE_MASTER_FILE" ? "/gone" : k === "HOME" ? "/home/u" : undefined;
    expect(resolveMasterSource(env, () => "{}", () => false)).toEqual({
      source: "dev-bootstrap",
      path: null,
    });
  });

  test("nothing configured ⇒ dev-bootstrap", () => {
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    expect(resolveMasterSource(env, () => "{}", () => false)).toEqual({
      source: "dev-bootstrap",
      path: null,
    });
  });
});
