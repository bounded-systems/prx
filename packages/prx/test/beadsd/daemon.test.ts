import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execBd as defaultExecBd, type BdExecOptions, type BdExecResult } from "@bounded-systems/bd";

import { FrameDecoder, encodeFrame } from "../../src/keeperd/daemon.ts";
import {
  handleBeadsRequest,
  runBeadsServe,
  type BeadsDaemonDeps,
} from "../../src/beadsd/daemon.ts";
import type { BeadsRequest } from "../../src/beadsd/contract.ts";

const READY: BeadsRequest = { kind: "ready" };

const okResult = (stdout = "[]"): BdExecResult => ({ exitCode: 0, stdout, stderr: "", policy: null });

/**
 * A fake `execBd` that records calls and answers with a canned result (default
 * an empty JSON array). No `bd` binary, no DB — the read dispatch is exercised
 * purely through the injected seam.
 */
function fakeBd(result: BdExecResult = okResult()): {
  execBd: typeof defaultExecBd;
  calls: BdExecOptions[];
} {
  const calls: BdExecOptions[] = [];
  const execBd = ((opts: BdExecOptions): BdExecResult => {
    calls.push(opts);
    return result;
  }) as typeof defaultExecBd;
  return { execBd, calls };
}

describe("handleBeadsRequest", () => {
  test("dispatches `ready` to `bd ready --json` and returns the parsed result", async () => {
    const { execBd, calls } = fakeBd(okResult(JSON.stringify([{ id: "prx-abb" }])));
    const res = await handleBeadsRequest(READY, { execBd });

    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.result).toEqual([{ id: "prx-abb" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subcommand).toBe("ready");
    expect(calls[0]!.args).toEqual(["--json"]);
  });

  test("dispatches `list` with no status to `bd list --json`", async () => {
    const { execBd, calls } = fakeBd();
    await handleBeadsRequest({ kind: "list" }, { execBd });
    expect(calls[0]!.subcommand).toBe("list");
    expect(calls[0]!.args).toEqual(["--json"]);
  });

  test("dispatches `list` with a status filter to `bd list --json --status <s>`", async () => {
    const { execBd, calls } = fakeBd();
    await handleBeadsRequest({ kind: "list", status: "open" }, { execBd });
    expect(calls[0]!.args).toEqual(["--json", "--status", "open"]);
  });

  test("dispatches `list --all --limit` (read parity)", async () => {
    const { execBd, calls } = fakeBd();
    await handleBeadsRequest({ kind: "list", all: true, limit: 0 }, { execBd });
    expect(calls[0]!.args).toEqual(["--json", "--all", "--limit", "0"]);
  });

  test("dispatches `ready --explain` (read parity)", async () => {
    const { execBd, calls } = fakeBd();
    await handleBeadsRequest({ kind: "ready", explain: true }, { execBd });
    expect(calls[0]!.subcommand).toBe("ready");
    expect(calls[0]!.args).toEqual(["--json", "--explain"]);
  });

  test("dispatches `show` to `bd show <id> --json` (id first)", async () => {
    const { execBd, calls } = fakeBd(okResult(JSON.stringify([{ id: "prx-abb", title: "x" }])));
    const res = await handleBeadsRequest({ kind: "show", id: "prx-abb" }, { execBd });
    expect(res.status).toBe("ok");
    expect(calls[0]!.subcommand).toBe("show");
    expect(calls[0]!.args).toEqual(["prx-abb", "--json"]);
  });

  test("threads cwd through to the bd runner", async () => {
    const { execBd, calls } = fakeBd();
    await handleBeadsRequest(READY, { execBd, cwd: "/repo/clone" });
    expect(calls[0]!.cwd).toBe("/repo/clone");
  });

  test("includes the dataset etag on ok replies when an etag source is wired (GH-296)", async () => {
    const { execBd } = fakeBd(okResult("[]"));
    const res = await handleBeadsRequest(READY, { execBd, etag: () => "head-abc123" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.etag).toBe("head-abc123");
  });

  test("omits etag when no source is wired", async () => {
    const { execBd } = fakeBd(okResult("[]"));
    const res = await handleBeadsRequest(READY, { execBd });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.etag).toBeUndefined();
  });

  test("maps a non-zero bd exit to a typed `bd-read` error carrying stderr", async () => {
    const { execBd } = fakeBd({ exitCode: 1, stdout: "", stderr: "bd-safe: nope", policy: null });
    const res = await handleBeadsRequest(READY, { execBd });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe("bd-read");
      expect(res.message).toContain("nope");
    }
  });

  test("maps unparseable stdout to a `bad-output` error (no throw)", async () => {
    const { execBd } = fakeBd(okResult("not json"));
    const res = await handleBeadsRequest(READY, { execBd });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("bad-output");
  });

  test("a throwing runner becomes a typed `beadsd` error, never propagates", async () => {
    const execBd = (() => {
      throw new Error("spawn blew up");
    }) as typeof defaultExecBd;
    const res = await handleBeadsRequest(READY, { execBd });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe("beadsd");
      expect(res.message).toContain("spawn blew up");
    }
  });
});

describe("handleBeadsRequest — writes (single-writer, policy passthrough)", () => {
  test("writes dispatch under the planner role/state (so bd policy allows them)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "create", issueType: "task", title: "t" }, { execBd });
    expect(calls[0]!.state).toBe("planning");
    expect(calls[0]!.role).toBe("planner");
  });

  test("create dispatches `bd create --json --type --title [--priority --description]`", async () => {
    const { execBd, calls } = fakeBd(okResult(JSON.stringify({ id: "prx-new" })));
    const res = await handleBeadsRequest(
      { kind: "create", issueType: "task", title: "do a thing", priority: 1, description: "why" },
      { execBd },
    );
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.result).toEqual({ id: "prx-new" });
    expect(calls[0]!.subcommand).toBe("create");
    expect(calls[0]!.args).toEqual([
      "--json",
      "--type",
      "task",
      "--title",
      "do a thing",
      "--priority",
      "1",
      "--description",
      "why",
    ]);
  });

  test("create omits optional flags when not given", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "create", issueType: "bug", title: "t" }, { execBd });
    expect(calls[0]!.args).toEqual(["--json", "--type", "bug", "--title", "t"]);
  });

  test("create passes --external-ref and --silent (write parity)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest(
      { kind: "create", issueType: "task", title: "t", externalRef: "https://github.com/o/r/issues/9", silent: true },
      { execBd },
    );
    expect(calls[0]!.args).toEqual([
      "--json",
      "--type",
      "task",
      "--title",
      "t",
      "--external-ref",
      "https://github.com/o/r/issues/9",
      "--silent",
    ]);
  });

  test("update passes --type (write parity)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "update", id: "prx-abb", issueType: "bug" }, { execBd });
    expect(calls[0]!.args).toEqual(["prx-abb", "--json", "--type", "bug"]);
  });

  test("update passes --title and --description (GH-296 GH→bd sync parity)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest(
      { kind: "update", id: "prx-abb", title: "new title", description: "new body" },
      { execBd },
    );
    expect(calls[0]!.args).toEqual([
      "prx-abb",
      "--json",
      "--title",
      "new title",
      "--description",
      "new body",
    ]);
  });

  test("update passes --external-ref and --notes (GH-296 write parity)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest(
      {
        kind: "update",
        id: "prx-abb",
        externalRef: "https://github.com/o/r/issues/9",
        notes: "linked by mirror",
      },
      { execBd },
    );
    expect(calls[0]!.args).toEqual([
      "prx-abb",
      "--json",
      "--external-ref",
      "https://github.com/o/r/issues/9",
      "--notes",
      "linked by mirror",
    ]);
  });

  test("reopen dispatches `bd reopen <id> --json` directly (allowed subcommand)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "reopen", id: "prx-abb" }, { execBd });
    expect(calls[0]!.subcommand).toBe("reopen");
    expect(calls[0]!.args).toEqual(["prx-abb", "--json"]);
  });

  test("dep add dispatches `bd dep add --type <t> <from> <to>` (GH-296)", async () => {
    const { execBd, calls } = fakeBd(okResult(""));
    const reply = await handleBeadsRequest(
      { kind: "dep", action: "add", from: "prx-a", to: "prx-b", depType: "parent-child" },
      { execBd },
    );
    expect(calls[0]!.subcommand).toBe("dep");
    expect(calls[0]!.args).toEqual(["add", "--type", "parent-child", "prx-a", "prx-b"]);
    // dep is not a --json surface: empty stdout on exit 0 ⇒ ok/null (not bad-output).
    expect(reply.status).toBe("ok");
    if (reply.status === "ok") expect(reply.result).toBeNull();
  });

  test("dep remove dispatches `bd dep remove <from> <to>` (GH-296)", async () => {
    const { execBd, calls } = fakeBd(okResult(""));
    await handleBeadsRequest({ kind: "dep", action: "remove", from: "prx-a", to: "prx-b" }, { execBd });
    expect(calls[0]!.subcommand).toBe("dep");
    expect(calls[0]!.args).toEqual(["remove", "prx-a", "prx-b"]);
  });

  test("update dispatches `bd update <id> --json <fields>`", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest(
      { kind: "update", id: "prx-abb", status: "in_progress", priority: 0, assignee: "alice" },
      { execBd },
    );
    expect(calls[0]!.subcommand).toBe("update");
    expect(calls[0]!.args).toEqual([
      "prx-abb",
      "--json",
      "--status",
      "in_progress",
      "--priority",
      "0",
      "--assignee",
      "alice",
    ]);
  });

  test("update with an empty assignee passes `--assignee ''` (clear semantics)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "update", id: "prx-abb", assignee: "" }, { execBd });
    expect(calls[0]!.args).toEqual(["prx-abb", "--json", "--assignee", ""]);
  });

  test("update with no fields is a bad-request (never reaches bd)", async () => {
    const { execBd, calls } = fakeBd();
    const res = await handleBeadsRequest({ kind: "update", id: "prx-abb" }, { execBd });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("bad-request");
    expect(calls).toHaveLength(0); // short-circuited before dispatch
  });

  test("close dispatches `bd update <id> --status closed [--notes]` (bd close is blocked)", async () => {
    const { execBd, calls } = fakeBd(okResult("{}"));
    await handleBeadsRequest({ kind: "close", id: "prx-abb", reason: "done" }, { execBd });
    // `bd close` is policy-blocked → the prx-canonical close is update --status closed.
    expect(calls[0]!.subcommand).toBe("update");
    expect(calls[0]!.args).toEqual(["prx-abb", "--json", "--status", "closed", "--notes", "done"]);
  });

  test("a write rejected by the bd policy layer surfaces as a bd-write error", async () => {
    // execBd returns non-zero (e.g. planner-role gate) — beadsd reports bd-write.
    const { execBd } = fakeBd({
      exitCode: 1,
      stdout: "",
      stderr: "bd-safe: blocked subcommand 'create' for state 'validating' role 'executor'",
      policy: null,
    });
    const res = await handleBeadsRequest({ kind: "create", issueType: "task", title: "t" }, { execBd });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe("bd-write");
      expect(res.message).toContain("blocked");
    }
  });
});

describe("runBeadsServe (unix socket, end-to-end)", () => {
  let server: Server | undefined;
  let socketPath: string | undefined;
  let counter = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(deps: BeadsDaemonDeps): Promise<string> {
    socketPath = join(tmpdir(), `beadsd-${process.pid}-${counter++}.sock`);
    server = await runBeadsServe({ socketPath, deps });
    return socketPath;
  }

  function sendFrame(path: string, value: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const dec = new FrameDecoder();
      const sock = connect(path, () => sock.write(encodeFrame(value)));
      sock.on("data", (chunk: Buffer) => {
        const frames = dec.push(chunk);
        if (frames.length > 0) {
          resolve(frames[0]);
          sock.end();
        }
      });
      sock.on("error", reject);
    });
  }

  test("serves a valid read to an ok verdict over the socket", async () => {
    const { execBd } = fakeBd(okResult(JSON.stringify([{ id: "prx-abb" }])));
    const path = await start({ execBd });
    const res = (await sendFrame(path, READY)) as { status: string; result?: unknown };
    expect(res.status).toBe("ok");
    expect(res.result).toEqual([{ id: "prx-abb" }]);
  });

  test("surfaces the dataset etag (readHead) on socket replies, re-read after refresh (GH-296)", async () => {
    const { execBd } = fakeBd(okResult(JSON.stringify([{ id: "prx-abb" }])));
    let head = "head-1";
    socketPath = join(tmpdir(), `beadsd-etag-${process.pid}-${counter++}.sock`);
    server = await runBeadsServe({
      socketPath,
      deps: { execBd },
      readHead: () => head,
      refresh: () => {
        head = "head-2"; // a reconcile that moved HEAD
      },
      refreshIntervalMs: 0, // refresh once on start
    });
    // refresh ran on start → HEAD moved to head-2, re-read into the cached etag.
    const res = (await sendFrame(socketPath, READY)) as { status: string; etag?: string };
    expect(res.status).toBe("ok");
    expect(res.etag).toBe("head-2");
  });

  test("runs the freshness refresh on start, then on the interval (GH-296)", async () => {
    const { execBd } = fakeBd();
    let refreshes = 0;
    socketPath = join(tmpdir(), `beadsd-refresh-${process.pid}-${counter++}.sock`);
    server = await runBeadsServe({
      socketPath,
      deps: { execBd },
      refresh: () => {
        refreshes += 1;
      },
      refreshIntervalMs: 20,
    });
    expect(refreshes).toBe(1); // initial pull, synchronously on start
    await new Promise((r) => setTimeout(r, 70));
    expect(refreshes).toBeGreaterThan(1); // interval fired at least once more
  });

  test("a throwing refresh never crashes the daemon", async () => {
    const { execBd } = fakeBd(okResult(JSON.stringify([{ id: "prx-abb" }])));
    socketPath = join(tmpdir(), `beadsd-refresh-throw-${process.pid}-${counter++}.sock`);
    server = await runBeadsServe({
      socketPath,
      deps: { execBd },
      refresh: () => {
        throw new Error("pull failed");
      },
      refreshIntervalMs: 0, // once on start only
    });
    // The daemon still serves despite the refresh throwing.
    const res = (await sendFrame(socketPath, READY)) as { status: string };
    expect(res.status).toBe("ok");
  });

  test("replies bad-request for a frame that violates the contract (daemon stays up)", async () => {
    const { execBd } = fakeBd();
    const path = await start({ execBd });
    const res = (await sendFrame(path, { kind: "create", title: "nope" })) as {
      status: string;
      code?: string;
    };
    expect(res.status).toBe("error");
    expect(res.code).toBe("bad-request");
  });

  test("writes its own pid to --pidfile while listening, removes it on close (GH-223)", async () => {
    const { execBd } = fakeBd();
    const sockPath = join(tmpdir(), `beadsd-pid-${process.pid}-${counter++}.sock`);
    const pidfile = join(tmpdir(), `beadsd-pid-${process.pid}-${counter++}.pid`);
    try {
      server = await runBeadsServe({ socketPath: sockPath, pidfile, deps: { execBd } });
      expect(existsSync(pidfile)).toBe(true);
      expect(readFileSync(pidfile, "utf8").trim()).toBe(String(process.pid));
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(pidfile, { force: true });
      rmSync(sockPath, { force: true });
    }
  });
});
