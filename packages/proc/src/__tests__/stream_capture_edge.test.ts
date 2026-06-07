// streamCapture edge cases: a timeout that kills the child, and a synchronous
// spawn failure (empty command → spawn throws on an undefined file).

import { describe, expect, test } from "bun:test";

import { streamCapture, isCaptureFailure } from "../capture.ts";

describe("streamCapture", () => {
  test("a timeout kills the long-running child and reports the signal", async () => {
    const r = await streamCapture(["sleep", "5"], { timeout: 50 });
    // The killed child surfaces as a capture failure (non-zero/null status or a
    // signal), never a clean exit.
    expect(isCaptureFailure(r)).toBe(true);
  });

  test("an empty command fails closed with an error rather than throwing", async () => {
    // cmd=[] → file is undefined → node's spawn throws synchronously; the
    // catch converts it into a settled failure result.
    const r = await streamCapture([]);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.status).toBeNull();
    expect(isCaptureFailure(r)).toBe(true);
  });
});
