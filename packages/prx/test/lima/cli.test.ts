import { describe, expect, test } from "bun:test";

import { CliError, normalizeNamespaceArgv, parseCommand } from "../../src/pr-state/cli.ts";

/** Mirror runCli: normalize the namespace argv, then parse. */
const parse = (argv: string[]) => parseCommand(normalizeNamespaceArgv(argv));

describe("prx beads serve parsing", () => {
  test("`beads serve` rewrites to the beads-serve command", () => {
    expect(normalizeNamespaceArgv(["beads", "serve", "--socket", "/x"])).toEqual([
      "beads-serve",
      "--socket",
      "/x",
    ]);
  });

  test("parses --socket/--cwd/--pidfile", () => {
    const p = parse(["beads", "serve", "--socket", "/vm/beadsd.sock", "--cwd", "/vm/clone", "--pidfile", "/vm/beadsd.pid"]);
    expect(p.command).toBe("beads-serve");
    if (p.command === "beads-serve") {
      expect(p.socket).toBe("/vm/beadsd.sock");
      expect(p.cwd).toBe("/vm/clone");
      expect(p.pidfile).toBe("/vm/beadsd.pid");
    }
  });

  test("requires --socket", () => {
    expect(() => parse(["beads", "serve"])).toThrow(/requires a socket/);
  });
});

describe("prx lima parsing", () => {
  test("`up <vm>` with --binary/--cwd", () => {
    const p = parse(["lima", "up", "myvm", "--binary", "dist/prx", "--cwd", "/vm/clone"]);
    expect(p.command).toBe("lima");
    if (p.command === "lima") {
      expect(p.verb).toBe("up");
      expect(p.vm).toBe("myvm");
      expect(p.binary).toBe("dist/prx");
      expect(p.cwd).toBe("/vm/clone");
    }
  });

  test("`daemons` needs no VM", () => {
    const p = parse(["lima", "daemons"]);
    expect(p.command === "lima" && p.verb).toBe("daemons");
  });

  test("`status <vm>` parses", () => {
    const p = parse(["lima", "status", "myvm", "--daemon", "beads"]);
    expect(p.command === "lima" && p.verb).toBe("status");
    if (p.command === "lima") expect(p.daemon).toBe("beads");
  });

  test("requires a known verb", () => {
    expect(() => parse(["lima"])).toThrow(/requires a verb/);
    expect(() => parse(["lima", "bogus"])).toThrow(/requires a verb/);
  });

  test("up requires --binary and --cwd", () => {
    expect(() => parse(["lima", "up", "myvm"])).toThrow(/--binary/);
    expect(() => parse(["lima", "up", "myvm", "--binary", "b"])).toThrow(/--cwd/);
  });

  test("up/down/status require a VM", () => {
    expect(() => parse(["lima", "down"])).toThrow(/requires a VM/);
    expect(() => parse(["lima", "status"])).toThrow(/requires a VM/);
  });

  test("rejects an unknown --daemon", () => {
    expect(() => parse(["lima", "up", "myvm", "--binary", "b", "--cwd", "/c", "--daemon", "bogus"])).toThrow(
      /--daemon must be one of/,
    );
  });

  test("--socket requires a single --daemon", () => {
    expect(() =>
      parse(["lima", "up", "myvm", "--binary", "b", "--cwd", "/c", "--socket", "/s"]),
    ).toThrow(/--socket requires a single --daemon/);
    // valid with a single daemon
    const p = parse(["lima", "up", "myvm", "--binary", "b", "--cwd", "/c", "--daemon", "keeper", "--socket", "/s"]);
    expect(p.command === "lima" && p.socket).toBe("/s");
  });

  test("is a CliError, not a raw throw", () => {
    let err: unknown;
    try {
      parse(["lima"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
  });
});
