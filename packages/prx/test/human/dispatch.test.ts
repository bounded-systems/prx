import { describe, expect, test } from "bun:test";

import type { HumanRequest } from "../../src/human/contract.ts";
import {
  dispatchToHuman,
  HumanProtocolError,
  type HumanResponder,
} from "../../src/human/dispatch.ts";

const APPROVAL: HumanRequest = { kind: "approval", action: "force-push main" };

describe("dispatchToHuman", () => {
  test("dispatches a valid request and returns the kind-matched response", async () => {
    let seen: HumanRequest | undefined;
    const responder: HumanResponder = async (req) => {
      seen = req;
      return { kind: "approval", approved: true };
    };
    const res = await dispatchToHuman(APPROVAL, responder);
    expect(seen).toEqual(APPROVAL);
    expect(res.kind).toBe("approval");
    if (res.kind === "approval") expect(res.approved).toBe(true);
  });

  test("a denial is DATA, not an exception", async () => {
    const res = await dispatchToHuman(APPROVAL, async () => ({
      kind: "approval",
      approved: false,
      reason: "scope too broad",
    }));
    expect(res.kind).toBe("approval");
    if (res.kind === "approval") {
      expect(res.approved).toBe(false);
      expect(res.reason).toBe("scope too broad");
    }
  });

  test("rejects an off-envelope request BEFORE it reaches the human", async () => {
    let called = false;
    const responder: HumanResponder = async () => {
      called = true;
      return { kind: "approval", approved: true };
    };
    const bad = { kind: "run-shell", command: "rm -rf /" } as unknown as HumanRequest;
    await expect(dispatchToHuman(bad, responder)).rejects.toBeInstanceOf(HumanProtocolError);
    // The boundary held: the agent can't smuggle an ambient action through the human.
    expect(called).toBe(false);
  });

  test("rejects a reply that violates the contract", async () => {
    await expect(
      dispatchToHuman(APPROVAL, async () => ({ kind: "approval" /* missing approved */ })),
    ).rejects.toBeInstanceOf(HumanProtocolError);
  });

  test("rejects a reply whose kind doesn't answer the request", async () => {
    await expect(
      dispatchToHuman(APPROVAL, async () => ({ kind: "decision", choice: "merge" })),
    ).rejects.toThrow(/'decision'.*'approval'/);
  });

  test("surfaces the offending field in the protocol error", async () => {
    await expect(
      dispatchToHuman({ kind: "decision", question: "?", options: ["a", "b"] }, async () => ({
        kind: "decision",
        choice: "",
      })),
    ).rejects.toThrow(/choice/);
  });
});
