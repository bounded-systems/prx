// GH-411 slice 1 — operatorConfigRoot() precedence + deprecated ai-home aliases.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { operatorConfigRoot } from "../src/operator-config.ts";

const KEYS = [
  "PRX_OPERATOR_CONFIG_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
  "BAKED_AI_HOME_ROOT",
] as const;

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

  test("honors the deprecated PRX_AI_HOME_ROOT alias", () => {
    process.env.PRX_AI_HOME_ROOT = "/legacy/ai-home";
    expect(operatorConfigRoot()).toBe("/legacy/ai-home");
  });

  test("neutral override wins over the deprecated alias", () => {
    process.env.PRX_OPERATOR_CONFIG_ROOT = "/op/root";
    process.env.PRX_AI_HOME_ROOT = "/legacy/ai-home";
    expect(operatorConfigRoot()).toBe("/op/root");
  });

  test("falls back to the baked default BAKED_OPERATOR_CONFIG_ROOT", () => {
    process.env.BAKED_OPERATOR_CONFIG_ROOT = "/baked/op";
    expect(operatorConfigRoot()).toBe("/baked/op");
  });

  test("honors the deprecated BAKED_AI_HOME_ROOT baked alias", () => {
    process.env.BAKED_AI_HOME_ROOT = "/baked/legacy";
    expect(operatorConfigRoot()).toBe("/baked/legacy");
  });

  test("a runtime override wins over the baked default", () => {
    process.env.BAKED_OPERATOR_CONFIG_ROOT = "/baked/op";
    process.env.PRX_OPERATOR_CONFIG_ROOT = "/op/root";
    expect(operatorConfigRoot()).toBe("/op/root");
  });

  test("the deprecated runtime alias still beats the baked default", () => {
    process.env.BAKED_OPERATOR_CONFIG_ROOT = "/baked/op";
    process.env.PRX_AI_HOME_ROOT = "/legacy/ai-home";
    expect(operatorConfigRoot()).toBe("/legacy/ai-home");
  });

  test("treats an empty string as unset", () => {
    process.env.PRX_OPERATOR_CONFIG_ROOT = "";
    expect(operatorConfigRoot()).toBeUndefined();
  });
});
