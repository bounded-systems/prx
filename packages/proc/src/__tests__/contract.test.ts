import { describe, expect, test } from "bun:test";

import { localProcExecutor, procRequestSchema } from "@bounded-systems/proc";

const exec = localProcExecutor();

describe("@bounded-systems/proc contract — localProcExecutor", () => {
  test("captures stdout + status of a successful command", async () => {
    const r = await exec.exec({ command: "printf", args: ["hi"] });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.signal).toBe(null);
  });

  test("serializable stdin is written to the child", async () => {
    const r = await exec.exec({ command: "cat", args: [], stdin: "from-contract" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("from-contract");
  });

  test("explicit env is passed through (never ambient)", async () => {
    const r = await exec.exec({
      command: "sh",
      args: ["-c", 'printf %s "$PRX_CONTRACT_X"'],
      env: { PRX_CONTRACT_X: "yes", PATH: process.env.PATH ?? "" },
    });
    expect(r.stdout).toBe("yes");
  });

  test("a non-zero exit is returned, not thrown (serializable result)", async () => {
    const r = await exec.exec({ command: "false", args: [] });
    expect(r.status).not.toBe(0);
  });

  test("procRequestSchema rejects an empty command (the validatable boundary)", () => {
    expect(() => procRequestSchema.parse({ command: "", args: [] })).toThrow();
  });

  test("procRequestSchema defaults args to [] and stdio to pipe", () => {
    const parsed = procRequestSchema.parse({ command: "true" });
    expect(parsed.args).toEqual([]);
    expect(parsed.stdio).toBe("pipe");
  });
});
