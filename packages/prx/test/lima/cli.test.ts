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

describe("prx beads doctor parsing", () => {
  test("`beads doctor` rewrites to beads-doctor (diagnose, fix=false)", () => {
    expect(normalizeNamespaceArgv(["beads", "doctor"])).toEqual(["beads-doctor"]);
    const p = parse(["beads", "doctor"]);
    expect(p.command).toBe("beads-doctor");
    if (p.command === "beads-doctor") expect(p.fix).toBe(false);
  });

  test("`beads doctor --fix --cwd <p>` parses", () => {
    const p = parse(["beads", "doctor", "--fix", "--cwd", "/wt"]);
    expect(p.command).toBe("beads-doctor");
    if (p.command === "beads-doctor") {
      expect(p.fix).toBe(true);
      expect(p.cwd).toBe("/wt");
    }
  });
});

describe("prx beads read-door (ready/list/show via beadsd)", () => {
  test("`beads ready --vm` rewrites to beads-read and parses", () => {
    expect(normalizeNamespaceArgv(["beads", "ready", "--vm", "myvm"])).toEqual([
      "beads-read",
      "ready",
      "--vm",
      "myvm",
    ]);
    const p = parse(["beads", "ready", "--vm", "myvm"]);
    expect(p.command).toBe("beads-read");
    if (p.command === "beads-read") {
      expect(p.kind).toBe("ready");
      expect(p.vm).toBe("myvm");
      expect(p.vmSocket).toBe("/tmp/beadsd.sock"); // default
    }
  });

  test("`beads list --vm --status open` carries the status", () => {
    const p = parse(["beads", "list", "--vm", "myvm", "--status", "open"]);
    expect(p.command === "beads-read" && p.kind).toBe("list");
    if (p.command === "beads-read") expect(p.status).toBe("open");
  });

  test("`beads show <id> --vm` carries the id", () => {
    const p = parse(["beads", "show", "prx-abb", "--vm", "myvm"]);
    expect(p.command === "beads-read" && p.kind).toBe("show");
    if (p.command === "beads-read") expect(p.id).toBe("prx-abb");
  });

  test("no --vm ⇒ local daemon (vm undefined, reachable from any shell)", () => {
    // GH-296: `prx beads ready` with no VM routes through the local daemon via
    // withBeadsClient (auto-started) — the reachable surface for any shell.
    const p = parse(["beads", "ready"]);
    expect(p.command).toBe("beads-read");
    if (p.command === "beads-read") {
      expect(p.kind).toBe("ready");
      expect(p.vm).toBeUndefined();
    }
  });

  test("show requires an id", () => {
    expect(() => parse(["beads", "show", "--vm", "myvm"])).toThrow(/requires an id/);
  });
});

describe("prx beads write-door (create/update/close via beadsd)", () => {
  test("`beads create` rewrites + builds a create request", () => {
    expect(normalizeNamespaceArgv(["beads", "create", "--type", "task", "--title", "x"])).toEqual([
      "beads-write",
      "create",
      "--type",
      "task",
      "--title",
      "x",
    ]);
    const p = parse(["beads", "create", "--type", "task", "--title", "do a thing", "--priority", "1"]);
    expect(p.command).toBe("beads-write");
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "create", issueType: "task", title: "do a thing", priority: 1 });
      expect(p.vm).toBeUndefined(); // no --vm ⇒ local daemon
    }
  });

  test("`beads update <id>` carries the changed fields", () => {
    const p = parse(["beads", "update", "prx-abb", "--status", "in_progress", "--assignee", "alice"]);
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "update", id: "prx-abb", status: "in_progress", assignee: "alice" });
    }
  });

  test("`beads close <id> --reason`", () => {
    const p = parse(["beads", "close", "prx-abb", "--reason", "done"]);
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "close", id: "prx-abb", reason: "done" });
    }
  });

  test("create requires --type and --title", () => {
    expect(() => parse(["beads", "create", "--title", "x"])).toThrow(/requires --type/);
    expect(() => parse(["beads", "create", "--type", "task"])).toThrow(/requires --title/);
  });

  test("update needs at least one field", () => {
    expect(() => parse(["beads", "update", "prx-abb"])).toThrow(/at least one/);
  });

  test("update/close require an id", () => {
    expect(() => parse(["beads", "update", "--status", "open"])).toThrow(/requires an id/);
    expect(() => parse(["beads", "close"])).toThrow(/requires an id/);
  });

  test("priority out of range is rejected", () => {
    expect(() => parse(["beads", "create", "--type", "task", "--title", "x", "--priority", "9"])).toThrow(
      /--priority must be an integer/,
    );
  });
});

describe("prx beads provision (canonical local clone)", () => {
  test("`beads provision --origin` rewrites + parses with a default cwd", () => {
    expect(normalizeNamespaceArgv(["beads", "provision", "--origin", "o/r"])).toEqual([
      "beads-provision",
      "--origin",
      "o/r",
    ]);
    const p = parse(["beads", "provision", "--origin", "o/r"]);
    expect(p.command).toBe("beads-provision");
    if (p.command === "beads-provision") {
      expect(p.origin).toBe("o/r");
      // default cwd = the well-known ~/.local/state/prx/beads (HOME is set in CI/dev)
      expect(p.cwd.endsWith("/.local/state/prx/beads")).toBe(true);
    }
  });

  test("`--cwd` overrides the canonical path", () => {
    const p = parse(["beads", "provision", "--origin", "o/r", "--cwd", "/canon"]);
    expect(p.command === "beads-provision" && p.cwd).toBe("/canon");
  });

  test("requires --origin", () => {
    expect(() => parse(["beads", "provision"])).toThrow(/requires --origin/);
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

  test("`provision-beads <vm> --origin` parses; requires --origin", () => {
    const p = parse(["lima", "provision-beads", "myvm", "--origin", "bounded-systems/prx"]);
    expect(p.command === "lima" && p.verb).toBe("provision-beads");
    if (p.command === "lima") {
      expect(p.vm).toBe("myvm");
      expect(p.origin).toBe("bounded-systems/prx");
    }
    expect(() => parse(["lima", "provision-beads", "myvm"])).toThrow(/requires --origin/);
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
