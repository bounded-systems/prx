---
"@bounded-systems/prx": patch
---

Remove the `dolt-data` nix FOD — `dolt clone`+`gc` are NOT byte-reproducible
across builders (proven: same pinned commit → different NAR hashes on Lima vs the
container builder), so a content-addressed fixed-output derivation is the wrong
model. The beads data volume is seeded by a builder-INDEPENDENT runtime clone of
the pinned commit instead (deterministic per-commit; the path `prx dolt provision`
should take when wired). Updates the dolt-service / pod-spec docs accordingly.
