/**
 * Generic temp-file-streamed `spawnSync` capture (GH-1609).
 *
 * Node/Bun's default `spawnSync` buffers stdout into memory with a 1 MiB cap;
 * when a child overflows the parent sets `error: ENOBUFS`, SIGTERMs the child,
 * and returns the partial bytes alongside the error. Every prx capture site
 * that does not override `maxBuffer` is one growth spurt away from that crash.
 *
 * `spawnCapture` is the lifted version of GH-1554's `defaultBdSpawn`: stream
 * the child's stdout straight to a per-call temp file (no in-memory ceiling),
 * read once after the child exits, and return the canonical `SpawnCaptureResult`
 * shape so each tool wrapper can apply its own `*-safe:` partial-read guard.
 *
 * Per-call temp dir, mode 0700, unguessable name — no race, no collision.
 *
 * Avoid `maxBuffer: Infinity`: the in-memory pipe still ties peak memory to
 * payload size; the temp-file approach is what GH-1554 verified under Bun.
 */
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SpawnCaptureResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** Fully-read child stdout — no in-memory ceiling. */
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

export type SpawnCaptureOptions = {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** ms; passed through to spawnSync. */
  timeout?: number | undefined;
};

export type SpawnCaptureFn = (
  cmd: readonly string[],
  options?: SpawnCaptureOptions,
) => SpawnCaptureResult;

export const spawnCapture: SpawnCaptureFn = (cmd, options = {}) => {
  const [file, ...args] = cmd;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prx-spawn-"));
  const outPath = path.join(dir, "out");
  // Open read+write so the child's stdout is read back from this same
  // descriptor rather than by re-opening `outPath` — accessing the path twice
  // (create, then read) is a TOCTOU race (CodeQL js/file-system-race).
  const fd = fs.openSync(outPath, "w+");
  try {
    const spawnOpts: SpawnSyncOptions = {
      // stdin ignored; stdout → file (no parent buffering); stderr → pipe (small).
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env as Record<string, string> | undefined,
      timeout: options.timeout,
    };
    const result = spawnSync(file!, args, spawnOpts);
    // The child shares this fd's open file description, so its writes advanced
    // the shared offset to EOF; read back from an explicit position 0.
    const size = fs.fstatSync(fd).size;
    let stdout = "";
    if (size > 0) {
      const buf = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const n = fs.readSync(fd, buf, read, size - read, read);
        if (n === 0) break;
        read += n;
      }
      stdout = buf.subarray(0, read).toString("utf8");
    }
    return {
      status: result.status,
      signal: result.signal,
      stdout,
      // `stdio[1]` being a numeric fd widens spawnSync's typed return to
      // `string | Buffer` even with `encoding: "utf8"`; normalise to a string.
      stderr: result.stderr == null ? "" : result.stderr.toString(),
      error: result.error ?? undefined,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed / never opened cleanly */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* cleanup is best-effort; never mask or throw over the real result */
    }
  }
};

/**
 * A spawn error (ENOBUFS, ENOENT, …), a killing signal (SIGTERM/SIGKILL), or
 * any non-zero exit means the stdout we hold is partial or absent. Callers
 * should refuse to return it as a payload and surface a `*-safe:` stderr.
 */
export function isCaptureFailure(r: SpawnCaptureResult): boolean {
  return Boolean(r.error || r.signal || (r.status ?? 1) !== 0);
}

/** Human-readable detail for the `*-safe:` stderr prefix. */
export function captureFailureDetail(r: SpawnCaptureResult): string {
  return r.error?.message ?? (r.signal ? `killed by ${r.signal}` : (r.stderr || "").trim());
}

export type StreamCaptureOptions = SpawnCaptureOptions & {
  /** Serializable stdin written to the child then closed (no live stream). */
  stdin?: string | undefined;
  /**
   * Called once per stdout chunk while the child runs. Strings are decoded
   * as UTF-8 from the chunk's bytes.
   */
  onStdout?: (chunk: string) => void;
  /** Called once per stderr chunk while the child runs. */
  onStderr?: (chunk: string) => void;
};

/**
 * GH-2014: async cousin of {@link spawnCapture} that tees each chunk through
 * an `onStdout`/`onStderr` callback while still streaming stdout to a per-call
 * temp file (GH-1609 — no in-memory ceiling). Stderr is captured in memory
 * because progress streams are bounded in practice.
 *
 * Use this when the operator needs continuous feedback during a long child
 * (`dolt clone`, `git fetch`, `gh pr list`). The temp-file pattern means the
 * captured stdout stays available for error formatting after the child exits.
 */
export function streamCapture(
  cmd: readonly string[],
  options: StreamCaptureOptions = {},
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    const [file, ...args] = cmd;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prx-stream-"));
    const outPath = path.join(dir, "out");
    const fd = fs.openSync(outPath, "w");
    let stderrBuf = "";
    let settled = false;
    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      let stdout = "";
      try {
        stdout = fs.readFileSync(outPath, "utf8");
      } catch {
        /* file unreadable — return empty stdout and surface the error */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* cleanup is best-effort */
      }
      resolve({
        status,
        signal,
        stdout,
        stderr: stderrBuf,
        ...(error ? { error } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file!, args, {
        cwd: options.cwd,
        env: options.env as Record<string, string> | undefined,
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(null, null, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (options.stdin !== undefined && child.stdin) {
      try {
        child.stdin.end(options.stdin);
      } catch {
        /* child may have exited before stdin was writable */
      }
    }

    let timer: NodeJS.Timeout | undefined;
    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      }, options.timeout);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      try {
        fs.writeSync(fd, text);
      } catch {
        /* keep streaming; the temp file may be closed under signal teardown */
      }
      try {
        options.onStdout?.(text);
      } catch {
        /* sink errors must not interrupt capture */
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuf += text;
      try {
        options.onStderr?.(text);
      } catch {
        /* sink errors must not interrupt capture */
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      finish(null, null, err);
    });
    child.on("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      finish(status, signal);
    });
  });
}
