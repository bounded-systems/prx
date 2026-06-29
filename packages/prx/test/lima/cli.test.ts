import { describe, expect, test } from "bun:test";

import { normalizeNamespaceArgv, parseCommand } from "../../src/pr-state/cli.ts";
import { CliError } from "../../src/pr-state/cli-error.ts";

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
    const p = parse([
      "beads",
      "serve",
      "--socket",
      "/vm/beadsd.sock",
      "--cwd",
      "/vm/clone",
      "--pidfile",
      "/vm/beadsd.pid",
    ]);
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

  test("`beads list --all --limit 0` carries the aggregate flags", () => {
    const p = parse(["beads", "list", "--all", "--limit", "0"]);
    if (p.command === "beads-read") {
      expect(p.all).toBe(true);
      expect(p.limit).toBe(0);
    }
  });

  test("a negative --limit is rejected", () => {
    expect(() => parse(["beads", "list", "--limit=-1"])).toThrow(
      /--limit must be a non-negative integer/,
    );
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

  test("`beads children <id>` rewrites to beads-read and carries the id (prx-zbsi)", () => {
    expect(normalizeNamespaceArgv(["beads", "children", "prx-epic"])).toEqual([
      "beads-read",
      "children",
      "prx-epic",
    ]);
    const p = parse(["beads", "children", "prx-epic"]);
    expect(p.command === "beads-read" && p.kind).toBe("children");
    if (p.command === "beads-read") expect(p.id).toBe("prx-epic");
  });

  test("children requires an id", () => {
    expect(() => parse(["beads", "children"])).toThrow(/requires an id/);
  });

  test("`beads recall <key>` carries the key; requires one (prx-44y)", () => {
    expect(normalizeNamespaceArgv(["beads", "recall", "handoff/a"])).toEqual([
      "beads-read",
      "recall",
      "handoff/a",
    ]);
    const p = parse(["beads", "recall", "handoff/a"]);
    expect(p.command === "beads-read" && p.kind).toBe("recall");
    if (p.command === "beads-read") expect(p.key).toBe("handoff/a");
    expect(() => parse(["beads", "recall"])).toThrow(/requires a key/);
  });

  test("`beads memories [<prefix>]` carries an optional prefix (prx-44y)", () => {
    const withPrefix = parse(["beads", "memories", "handoff/"]);
    expect(withPrefix.command === "beads-read" && withPrefix.kind).toBe("memories");
    if (withPrefix.command === "beads-read") expect(withPrefix.prefix).toBe("handoff/");
    const noPrefix = parse(["beads", "memories"]);
    if (noPrefix.command === "beads-read") expect(noPrefix.prefix).toBeUndefined();
  });

  test("reads tolerate a forwarded --json flag (the door dialer forwards it; prx-zbsi)", () => {
    // `bd show <id> --json` → `prx beads show <id> --json` over the door, so the
    // read parser must accept --json rather than reject it under strict parsing.
    expect(() => parse(["beads", "show", "prx-abb", "--json"])).not.toThrow();
    expect(() => parse(["beads", "children", "prx-epic", "--json"])).not.toThrow();
    expect(() => parse(["beads", "list", "--json"])).not.toThrow();
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
    const p = parse([
      "beads",
      "create",
      "--type",
      "task",
      "--title",
      "do a thing",
      "--priority",
      "1",
    ]);
    expect(p.command).toBe("beads-write");
    if (p.command === "beads-write") {
      expect(p.request).toEqual({
        kind: "create",
        issueType: "task",
        title: "do a thing",
        priority: 1,
      });
      expect(p.vm).toBeUndefined(); // no --vm ⇒ local daemon
    }
  });

  test("`beads update <id>` carries the changed fields", () => {
    const p = parse([
      "beads",
      "update",
      "prx-abb",
      "--status",
      "in_progress",
      "--assignee",
      "alice",
    ]);
    if (p.command === "beads-write") {
      expect(p.request).toEqual({
        kind: "update",
        id: "prx-abb",
        status: "in_progress",
        assignee: "alice",
      });
    }
  });

  test("`beads close <id> --reason`", () => {
    const p = parse(["beads", "close", "prx-abb", "--reason", "done"]);
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "close", id: "prx-abb", reason: "done" });
    }
  });

  test("`beads reopen <id>`", () => {
    expect(normalizeNamespaceArgv(["beads", "reopen", "prx-abb"])).toEqual([
      "beads-write",
      "reopen",
      "prx-abb",
    ]);
    const p = parse(["beads", "reopen", "prx-abb"]);
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "reopen", id: "prx-abb" });
    }
  });

  test("reopen requires an id", () => {
    expect(() => parse(["beads", "reopen"])).toThrow(/requires an id/);
  });

  test("`beads remember <body> --key <key>` builds a remember write (prx-44y)", () => {
    expect(normalizeNamespaceArgv(["beads", "remember", "{}", "--key", "handoff/a"])).toEqual([
      "beads-write",
      "remember",
      "{}",
      "--key",
      "handoff/a",
    ]);
    const p = parse(["beads", "remember", '{"id":"h1"}', "--key", "handoff/a"]);
    expect(p.command).toBe("beads-write");
    if (p.command === "beads-write") {
      expect(p.request).toEqual({ kind: "remember", key: "handoff/a", body: '{"id":"h1"}' });
    }
  });

  test("remember requires --key and a body", () => {
    expect(() => parse(["beads", "remember", "{}"])).toThrow(/requires --key/);
    expect(() => parse(["beads", "remember", "--key", "k"])).toThrow(/requires a body/);
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
    expect(() =>
      parse(["beads", "create", "--type", "task", "--title", "x", "--priority", "9"]),
    ).toThrow(/--priority must be an integer/);
  });
});

describe("prx beads prime (daemon-aware session primer)", () => {
  test("`beads prime` rewrites + parses (local daemon by default)", () => {
    expect(normalizeNamespaceArgv(["beads", "prime"])).toEqual(["beads-prime"]);
    const p = parse(["beads", "prime"]);
    expect(p.command).toBe("beads-prime");
    if (p.command === "beads-prime") {
      expect(p.vm).toBeUndefined();
      expect(p.format).toBe("plain");
    }
  });

  test("`beads prime --vm --format json` carries through", () => {
    const p = parse(["beads", "prime", "--vm", "myvm", "--format", "json"]);
    if (p.command === "beads-prime") {
      expect(p.vm).toBe("myvm");
      expect(p.format).toBe("json");
    }
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
  // The in-VM daemons (up/down/daemons/status/provision-beads) were retired for
  // the podman pod (prx-zj8); only the nix builder (provision-builder) remains.
  test("requires the provision-builder verb (daemon verbs retired)", () => {
    expect(() => parse(["lima"])).toThrow(/requires a verb/);
    expect(() => parse(["lima", "bogus"])).toThrow(/requires a verb/);
    expect(() => parse(["lima", "up", "myvm"])).toThrow(/requires a verb/);
    expect(() => parse(["lima", "daemons"])).toThrow(/requires a verb/);
  });

  test("`provision-builder <vm>` parses with defaults", () => {
    const p = parse(["lima", "provision-builder", "myvm"]);
    expect(p.command === "lima" && p.verb).toBe("provision-builder");
    if (p.command === "lima") {
      expect(p.vm).toBe("myvm");
      expect(p.maxJobs).toBeUndefined();
      expect(p.systems).toBeUndefined();
      expect(p.installerUrl).toBeUndefined();
    }
  });

  test("`provision-builder` carries --max-jobs/--systems/--installer-url", () => {
    const p = parse([
      "lima",
      "provision-builder",
      "myvm",
      "--max-jobs",
      "8",
      "--systems",
      "aarch64-linux",
      "--installer-url",
      "https://nixos.org/nix/install",
    ]);
    if (p.command === "lima") {
      expect(p.maxJobs).toBe(8);
      expect(p.systems).toBe("aarch64-linux");
      expect(p.installerUrl).toBe("https://nixos.org/nix/install");
    }
  });

  test("`provision-builder` requires a VM and rejects a bad --max-jobs", () => {
    expect(() => parse(["lima", "provision-builder"])).toThrow(/requires a VM/);
    expect(() => parse(["lima", "provision-builder", "myvm", "--max-jobs", "0"])).toThrow(
      /--max-jobs must be a positive integer/,
    );
    expect(() => parse(["lima", "provision-builder", "myvm", "--max-jobs", "x"])).toThrow(
      /--max-jobs must be a positive integer/,
    );
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
