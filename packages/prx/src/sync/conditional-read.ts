// GH-296 / prx-lzw (lever 1) — the pure core of the GH→bd pull-leg conditional
// read. The reconcile pull leg re-reads EVERY pinned GitHub issue every tick
// (not --limit-gated) — the API hog. A GitHub conditional request
// (`If-None-Match: <etag>`) turns an unchanged issue into a `304 Not Modified`,
// which is FREE against the rate limit. GitHub itself is authoritative on
// changed-vs-unchanged, so reusing the cached state on a 304 is provably correct
// (unlike a client-side updatedAt heuristic that could miss an edit).
//
// The subtle, must-test part lives here, isolated from IO: `gh api -i` exits
// NON-ZERO on a 304 *and* on a genuine error (404/410/5xx), so the exit code
// alone cannot tell "unchanged" from "broken". The HTTP status line in the `-i`
// output is the source of truth. The adapter just runs `gh api` and feeds the
// raw result here; the run loop persists the etag via the pull-etag store.

/** The decision from a single `gh api … -i` conditional read. */
export type ConditionalReadResult =
  /** `304 Not Modified` — the issue is unchanged; reuse the cached state (free). */
  | { kind: "not-modified" }
  /** A fresh `2xx` body, with the new ETag to persist (undefined if absent). */
  | { kind: "modified"; etag: string | undefined; body: string }
  /** Anything else (404/410/5xx, or no parseable HTTP status) — a real failure. */
  | { kind: "error"; status: number | undefined; detail: string };

/** The raw outcome of `gh api <path> -i [-H "If-None-Match: …"]`. */
export type RawConditionalRead = {
  /** The process exit code (`gh api` exits 1 on BOTH 304 and HTTP errors). */
  exitCode: number;
  /** Combined `-i` output: the HTTP status line, headers, blank line, then body. */
  output: string;
};

/** Match `HTTP/1.1 304 Not Modified` / `HTTP/2.0 200 OK` → the numeric status. */
const STATUS_LINE = /^HTTP\/[\d.]+\s+(\d{3})\b/i;
const ETAG_HEADER = /^etag:\s*(.+)$/i;

/**
 * Classify a conditional read from its raw `gh api -i` output. Keys on the HTTP
 * status line (NOT the exit code, which is 1 for both 304 and errors). When no
 * status line is present (e.g. a network failure wrote only to stderr), the read
 * is an error — never silently treated as "unchanged".
 */
export function parseConditionalRead(raw: RawConditionalRead): ConditionalReadResult {
  const lines = raw.output.split("\n");

  let status: number | undefined;
  let etag: string | undefined;
  let blankAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (status === undefined) {
      const m = STATUS_LINE.exec(line);
      if (m) {
        status = Number(m[1]);
        continue;
      }
    }
    if (line === "") {
      blankAt = i; // end of headers → body follows
      break;
    }
    const e = ETAG_HEADER.exec(line);
    if (e) etag = e[1]!.trim();
  }

  if (status === undefined) {
    const detail = raw.output.trim() || `gh api exited ${raw.exitCode} with no HTTP status`;
    return { kind: "error", status: undefined, detail };
  }
  if (status === 304) return { kind: "not-modified" };

  const body =
    blankAt >= 0
      ? lines
          .slice(blankAt + 1)
          .join("\n")
          .trim()
      : "";
  if (status >= 200 && status < 300) return { kind: "modified", etag, body };

  return { kind: "error", status, detail: body || `HTTP ${status}` };
}
