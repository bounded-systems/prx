import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  pinTransitionArtifact,
  type PinTransitionDeps,
} from "../../src/session/transition-artifact.ts";

const schema = z.object({ status: z.string(), prNumber: z.number().optional() });

function recordingDeps(): { deps: PinTransitionDeps; calls: { blob: string[]; refs: Array<[string, string]> } } {
  const calls = { blob: [] as string[], refs: [] as Array<[string, string]> };
  const deps: PinTransitionDeps = {
    writeBlob: async (content) => {
      calls.blob.push(String(content));
      return { sha: `sha256:${"a".repeat(64)}` };
    },
    setRef: async (name, sha) => {
      calls.refs.push([name, sha]);
    },
    casUriFor: (domain, sha) => `${domain}://${sha}`,
  };
  return { deps, calls };
}

describe("pinTransitionArtifact (ai-home-wlw5l)", () => {
  test("validates the object then pins the canonical form, returns a domain handle", async () => {
    const { deps, calls } = recordingDeps();
    const res = await pinTransitionArtifact(
      { raw: '{"status":"ready","prNumber":42,"extra":"x"}', schema, domain: "author", ref: "transition:author:GH-1" },
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.handle).toBe(`author://sha256:${"a".repeat(64)}`);
    }
    // Canonical validated object is pinned (unknown `extra` key stripped by the schema).
    expect(calls.blob).toEqual(['{"status":"ready","prNumber":42}']);
    expect(calls.refs).toEqual([["transition:author:GH-1", `sha256:${"a".repeat(64)}`]]);
  });

  test("empty slot is rejected and never pinned", async () => {
    const { deps, calls } = recordingDeps();
    const res = await pinTransitionArtifact({ raw: "  ", schema, domain: "author", ref: "r" }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");
    expect(calls.blob).toEqual([]);
  });

  test("non-JSON slot is rejected and never pinned", async () => {
    const { deps, calls } = recordingDeps();
    const res = await pinTransitionArtifact({ raw: "not json", schema, domain: "author", ref: "r" }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_json");
    expect(calls.blob).toEqual([]);
  });

  test("schema-invalid object is rejected and never pinned (instrument != finding)", async () => {
    const { deps, calls } = recordingDeps();
    // Valid JSON, but `status` is the wrong type — the emitted object fails the
    // role schema even if the run was instructed to produce it.
    const res = await pinTransitionArtifact({ raw: '{"status":123}', schema, domain: "author", ref: "r" }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("schema_invalid");
    expect(calls.blob).toEqual([]);
    expect(calls.refs).toEqual([]);
  });
});
