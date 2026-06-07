---
"@bounded-systems/prx": patch
---

`prx provenance setup` (GH-352): promotes the signing-setup step into a first-class command — derive each actor's public key from the resolved master, publish the trust map, verify drift is clean, and report the resulting posture (idempotent; exits non-zero if drift remains). `setup-provenance-signing` is now a thin wrapper that adds a master file-perms preflight and delegates to it; the `prx provenance status` onboarding text and `docs/provenance/signing.md` point at the command.
