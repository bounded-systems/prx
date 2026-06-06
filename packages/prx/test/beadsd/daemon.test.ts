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
