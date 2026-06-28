---
"@bounded-systems/prx": patch
---

Mint the prx-forge App token in release-binary.yml's update-hashes job (prx-zee7 Phase 5 leftover) so the release-hashes/brew-formula PR opens automatically. It used GITHUB_TOKEN, which "is not permitted to create or approve pull requests" — so every release's hashes PR failed and had to be opened by hand (e.g. #811 for v0.17.0). Mirrors version.yml; falls back to GITHUB_TOKEN when the app var is unset.
