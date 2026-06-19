import { describe, expect, test } from "bun:test";
import {
  execSlackRead,
  SlackReadError,
  type SlackKeymaker,
  type ScopedSlackKey,
  type SlackReadOp,
  type SlackReadTransport,
} from "@bounded-systems/slack";

// A keymaker that records what it was asked to mint and hands back a key whose
// scope mirrors the grant. No secret — proves the pipeline only needs the port.
function recordingKeymaker(): { km: SlackKeymaker; minted: ScopedSlackKey[] } {
  const minted: ScopedSlackKey[] = [];
  const km: SlackKeymaker = {
    mint(grant) {
      const key: ScopedSlackKey = {
        keyId: `k-${grant.scope.ops.join(",")}`,
        scope: grant.scope,
        expiresAt: 10_000,
        authorize: (_target, req) => ({
          ...req,
          headers: { ...(req.headers ?? {}), Authorization: "Bearer T" },
        }),
      };
      minted.push(key);
      return key;
    },
  };
  return { km, minted };
}

// A transport that echoes the op and records the key it received.
function recordingTransport(): {
  transport: SlackReadTransport;
  seen: { op?: SlackReadOp; key?: ScopedSlackKey };
} {
  const seen: { op?: SlackReadOp; key?: ScopedSlackKey } = {};
  const transport: SlackReadTransport = {
    async call(op, _params, key) {
      seen.op = op;
      seen.key = key;
      return { ok: true, data: { echoed: op }, cursor: null };
    },
  };
  return { transport, seen };
}

describe("execSlackRead", () => {
  test("an allowed read returns the result + a content address + the allow decision", async () => {
    const { km } = recordingKeymaker();
    const { transport } = recordingTransport();
    const env = await execSlackRead(
      "history",
      { channel: "C1", limit: 10 },
      { keymaker: km, transport },
    );
    expect(env.result.ok).toBe(true);
    expect(env.result.data).toEqual({ echoed: "history" });
    expect(env.policy.allowed).toBe(true);
    expect(env.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the content address is stable across calls and varies with params", async () => {
    const { km } = recordingKeymaker();
    const { transport } = recordingTransport();
    const a = await execSlackRead(
      "history",
      { channel: "C1", limit: 10 },
      { keymaker: km, transport },
    );
    const b = await execSlackRead(
      "history",
      { channel: "C1", limit: 10 },
      { keymaker: km, transport },
    );
    const c = await execSlackRead(
      "history",
      { channel: "C2", limit: 10 },
      { keymaker: km, transport },
    );
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
  });

  test("mints a key scoped to exactly {op, channel} for a channel read", async () => {
    const { km, minted } = recordingKeymaker();
    const { transport, seen } = recordingTransport();
    await execSlackRead("history", { channel: "C1" }, { keymaker: km, transport });
    expect(minted).toHaveLength(1);
    expect(minted[0]!.scope).toEqual({ ops: ["history"], channels: ["C1"] });
    // the very key minted is the one the transport receives
    expect(seen.key).toBe(minted[0]);
  });

  test("a channel-less op mints a key with no channel constraint", async () => {
    const { km, minted } = recordingKeymaker();
    const { transport } = recordingTransport();
    await execSlackRead("channels", { limit: 5 }, { keymaker: km, transport });
    expect(minted[0]!.scope).toEqual({ ops: ["channels"] });
  });

  test("derives the narrowest scope across org/channel/thread (prx-q7r least authority)", async () => {
    const { km, minted } = recordingKeymaker();
    const { transport } = recordingTransport();
    // team_id → orgs, channel → channels, the replies parent ts → threads.
    await execSlackRead("thread", { channel: "C1", ts: "169.1", team_id: "T1" } as never, {
      keymaker: km,
      transport,
    });
    expect(minted[0]!.scope).toEqual({
      ops: ["thread"],
      orgs: ["T1"],
      channels: ["C1"],
      threads: ["169.1"],
    });
  });

  test("a denied (state, role) is refused before any transport call (POLICY_BLOCKED)", async () => {
    const { km } = recordingKeymaker();
    const { transport, seen } = recordingTransport();
    // keeper/forge have no slack rows → denied.
    await expect(
      execSlackRead("history", { channel: "C1" }, { keymaker: km, transport, role: "keeper" }),
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(seen.op).toBeUndefined(); // transport never reached
  });

  test("the refusal is a typed SlackReadError", async () => {
    const { km } = recordingKeymaker();
    const { transport } = recordingTransport();
    try {
      await execSlackRead("users", {}, { keymaker: km, transport, role: "forge" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SlackReadError);
      expect((e as SlackReadError).code).toBe("POLICY_BLOCKED");
    }
  });
});
