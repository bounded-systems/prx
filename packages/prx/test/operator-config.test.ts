// GH-411 — operatorConfigRoot() precedence (slice 5 dropped the ai-home aliases).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  operatorConfigRoot,
  operatorConfigPath,
  readOperatorConfig,
  readOperatorConfigStringMap,
} from "../src/operator-config.ts";

const KEYS = ["PRX_OPERATOR_CONFIG_ROOT", "BAKED_OPERATOR_CONFIG_ROOT"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("operatorConfigRoot", () => {
  test("returns undefined when nothing is configured", () => {
    expect(operatorConfigRoot()).toBeUndefined();
  });

  test("reads the neutral override PRX_OPERATOR_CONFIG_ROOT", () => {
    process.env.PRX_OPERATOR_CONFIG_ROOT = "/op/root";
    expect(operatorConfigRoot()).toBe("/op/root");
  });

  test("falls back to the baked default BAKED_OPERATOR_CONFIG_ROOT", () => {
    process.env.BAKED_OPERATOR_CONFIG_ROOT = "/baked/op";
    expect(operatorConfigRoot()).toBe("/baked/op");
  });

  test("a runtime override wins over the baked default", () => {
    process.env.BAKED_OPERATOR_CONFIG_ROOT = "/baked/op";
    process.env.PRX_OPERATOR_CONFIG_ROOT = "/op/root";
    expect(operatorConfigRoot()).toBe("/op/root");
  });

  test("the dropped PRX_AI_HOME_ROOT alias is no longer read (slice 5)", () => {
    process.env.PRX_AI_HOME_ROOT = "/legacy/ai-home";
    try {
      expect(operatorConfigRoot()).toBeUndefined();
    } finally {
      delete process.env.PRX_AI_HOME_ROOT;
    }
  });

  test("treats an empty string as unset", () => {
    process.env.PRX_OPERATOR_CONFIG_ROOT = "";
    expect(operatorConfigRoot()).toBeUndefined();
  });
});

describe("readOperatorConfig / readOperatorConfigStringMap (GH-411 slice 4)", () => {
  const withConfig = (obj: unknown) => ({
    homeDir: "/home/op",
    pathExists: (p: string) => p === "/home/op/.config/prx/config.json",
    readFile: () => JSON.stringify(obj),
  });

  test("operatorConfigPath joins ~/.config/prx/config.json", () => {
    expect(operatorConfigPath({ homeDir: "/home/op" })).toBe("/home/op/.config/prx/config.json");
  });

  test("readOperatorConfig parses the file, {} when absent or malformed", () => {
    expect(readOperatorConfig(withConfig({ a: 1 }))).toEqual({ a: 1 });
    expect(readOperatorConfig({ homeDir: "/home/op", pathExists: () => false })).toEqual({});
    expect(
      readOperatorConfig({ homeDir: "/home/op", pathExists: () => true, readFile: () => "{ bad" }),
    ).toEqual({});
  });

  test("readOperatorConfigStringMap extracts a string map, trims, drops non-strings/empties", () => {
    expect(
      readOperatorConfigStringMap(
        "scopeMap",
        withConfig({ scopeMap: { "o/r": " prx ", "a/b": "", "c/d": 5, "e/f": "x" } }),
      ),
    ).toEqual({ "o/r": "prx", "e/f": "x" });
  });

  test("readOperatorConfigStringMap → {} when the block is absent or not an object", () => {
    expect(readOperatorConfigStringMap("scopeMap", withConfig({}))).toEqual({});
    expect(readOperatorConfigStringMap("scopeMap", withConfig({ scopeMap: ["x"] }))).toEqual({});
    expect(readOperatorConfigStringMap("scopeMap", withConfig({ scopeMap: "nope" }))).toEqual({});
  });
});
