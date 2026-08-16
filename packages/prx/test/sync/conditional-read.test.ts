import { describe, expect, test } from "bun:test";

import { parseConditionalRead } from "../../src/sync/conditional-read.ts";

// A `gh api … -i` 200 response: status line, headers, blank line, JSON body.
const ok200 = [
  "HTTP/2.0 200 OK",
  'Etag: W/"abc123"',
  "X-Ratelimit-Remaining: 4900",
  "Content-Type: application/json",
  "",
  '{"number":501,"state":"open"}',
].join("\n");

// `gh api … -i -H "If-None-Match: …"` on an unchanged issue: exit 1, no body.
const notModified = ["HTTP/2.0 304 Not Modified", 'Etag: W/"abc123"', "", ""].join("\n");

describe("parseConditionalRead", () => {
  test("304 (exit 1) ⇒ not-modified — keyed on the status line, not the exit code", () => {
    const r = parseConditionalRead({ exitCode: 1, output: notModified });
    expect(r.kind).toBe("not-modified");
  });

  test("200 ⇒ modified with the fresh ETag and the JSON body", () => {
    const r = parseConditionalRead({ exitCode: 0, output: ok200 });
    expect(r).toEqual({
      kind: "modified",
      etag: 'W/"abc123"',
      body: '{"number":501,"state":"open"}',
    });
  });

  test("200 with no ETag header ⇒ modified, etag undefined", () => {
    const r = parseConditionalRead({
      exitCode: 0,
      output: ["HTTP/2.0 200 OK", "", "{}"].join("\n"),
    });
    expect(r).toEqual({ kind: "modified", etag: undefined, body: "{}" });
  });

  test("404 (also exit 1) ⇒ error with the status, NOT mistaken for not-modified", () => {
    const r = parseConditionalRead({
      exitCode: 1,
      output: ["HTTP/2.0 404 Not Found", "", '{"message":"Not Found"}'].join("\n"),
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBe(404);
      expect(r.detail).toContain("Not Found");
    }
  });

  test("no HTTP status line (network failure on stderr) ⇒ error, never not-modified", () => {
    const r = parseConditionalRead({
      exitCode: 1,
      output: "error connecting to api.github.com",
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBeUndefined();
      expect(r.detail).toContain("connecting");
    }
  });

  test("tolerates CRLF line endings", () => {
    const r = parseConditionalRead({ exitCode: 1, output: notModified.replace(/\n/g, "\r\n") });
    expect(r.kind).toBe("not-modified");
  });

  test("a body with blank lines is preserved past the header boundary", () => {
    const r = parseConditionalRead({
      exitCode: 0,
      output: ["HTTP/2.0 200 OK", "", "{", '  "a": 1', "", "}"].join("\n"),
    });
    expect(r.kind).toBe("modified");
    if (r.kind === "modified") expect(r.body).toBe('{\n  "a": 1\n\n}');
  });
});
