import { describe, expect, test } from "bun:test";

import { readDoltHead } from "../../src/beadsd/dolt-head.ts";

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" }) as never;

describe("readDoltHead", () => {
  test("reads hashof('HEAD') from the reverse-DNS db dir under the clone", () => {
    const calls: { cmd: string[]; cwd?: string }[] = [];
    const head = readDoltHead("/clone", {
      listDbDirs: () => ["io_github_x_y"],
      run: ((cmd: string[], o?: { cwd?: string }) => {
        calls.push({ cmd, ...(o?.cwd !== undefined ? { cwd: o.cwd } : {}) });
        return ok("head\nuoev8kinb09rfg\n");
      }) as never,
    });
    expect(head).toBe("uoev8kinb09rfg");
    expect(calls[0]!.cmd).toEqual(["dolt", "sql", "-q", "select hashof('HEAD')", "-r", "csv"]);
    expect(calls[0]!.cwd).toBe("/clone/.beads/dolt/io_github_x_y");
  });

  test("undefined when there is no db dir", () => {
    expect(readDoltHead("/clone", { listDbDirs: () => [] })).toBeUndefined();
  });

  test("undefined on a non-zero dolt exit (server down)", () => {
    expect(
      readDoltHead("/clone", {
        listDbDirs: () => ["db"],
        run: (() => ({ status: 1, stdout: "", stderr: "no server" })) as never,
      }),
    ).toBeUndefined();
  });

  test("undefined when the listing throws (no .beads/dolt)", () => {
    expect(
      readDoltHead("/clone", {
        listDbDirs: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
  });
});
