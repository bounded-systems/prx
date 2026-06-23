---
---

Add `scripts/keeperd/launch-keygen.ts` — generate the launcher signing keypair
(capability chain L2). Pure `generateLaunchKeypair()` (ed25519 PEM,
verifier-compatible) + a CLI that stores the PRIVATE half in 1Password (as a
document, so it never touches argv) and writes/emits the PUBLIC half
(`PRX_LAUNCH_PUBKEY`), printing the deploy (`podman secret create prx-launch-key`),
verifier (pin), and publish (`.well-known`) steps. Mirrors the keeper-key
discipline, one tier up. No release.
