import { afterEach, describe, expect, test } from "bun:test";
import { deleteEnv, firstEnv, getEnv, processEnv, requireEnv, setEnv } from "@bounded-systems/env";

const KEY = "PRX_ENV_CAP_TEST";
const KEY2 = "PRX_ENV_CAP_TEST_2";
afterEach(() => {
  delete process.env[KEY];
  delete process.env[KEY2];
});

describe("@bounded-systems/env", () => {
  test("getEnv returns the value or undefined", () => {
    expect(getEnv(KEY)).toBeUndefined();
    process.env[KEY] = "v";
    expect(getEnv(KEY)).toBe("v");
  });

  test("requireEnv throws when unset or empty", () => {
    expect(() => requireEnv(KEY)).toThrow(/PRX_ENV_CAP_TEST/);
    process.env[KEY] = "";
    expect(() => requireEnv(KEY)).toThrow();
    process.env[KEY] = "ok";
    expect(requireEnv(KEY)).toBe("ok");
  });

  test("firstEnv honors precedence and skips empty", () => {
    expect(firstEnv(KEY, KEY2)).toBeNull();
    process.env[KEY2] = "second";
    expect(firstEnv(KEY, KEY2)).toBe("second");
    process.env[KEY] = "first";
    expect(firstEnv(KEY, KEY2)).toBe("first");
  });

  test("processEnv exposes the ambient environment", () => {
    expect(processEnv()).toBe(process.env);
  });

  test("setEnv / deleteEnv mutate the ambient environment", () => {
    expect(getEnv(KEY)).toBeUndefined();
    setEnv(KEY, "written");
    expect(getEnv(KEY)).toBe("written");
    deleteEnv(KEY);
    expect(getEnv(KEY)).toBeUndefined();
  });
});
