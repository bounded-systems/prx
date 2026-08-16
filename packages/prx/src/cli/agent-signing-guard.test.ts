import { describe, expect, test } from "bun:test";
import { ed25519Signer, generateEd25519Keypair } from "@bounded-systems/anchored-chain";

import { cliActor, requireCliSigner, requireSigner } from "./agent-signing-guard.ts";

const kp = generateEd25519Keypair();
const signer = ed25519Signer(kp.privateKey, kp.keyid);

describe("no agent launches without a signing key", () => {
  test("requireSigner refuses when no key resolves; returns the key otherwise", () => {
    expect(() => requireSigner("pilot", () => null)).toThrow("must hold a signing key");
    expect(requireSigner("pilot", () => signer)).toBe(signer);
  });

  test("the CLI is an actor that inherits identity from the tty", () => {
    expect(cliActor({ isTTY: true })).toEqual({ actor: "human", interactive: true });
    expect(cliActor({ isTTY: true, user: "bdelanghe" })).toEqual({
      actor: "bdelanghe",
      interactive: true,
    });
    expect(cliActor({ isTTY: false })).toEqual({ actor: "noninteractive", interactive: false });
  });

  test("the human/CLI actor must hold a key too", () => {
    const got = requireCliSigner({ isTTY: true, user: "bob", resolve: () => signer });
    expect(got.actor).toEqual({ actor: "bob", interactive: true });
    expect(got.signer).toBe(signer);
    expect(() => requireCliSigner({ isTTY: false, resolve: () => null })).toThrow(
      "must hold a signing key",
    );
  });
});
