---
"@bounded-systems/prx": patch
---

Route the in-box `bd show` reads through the beadsd door in the box profile (prx-zbsi, GH-296 AC #3 follow-up). Both `hydrateBeads` (the beads hydration actor) and `readBdLabels` (the delegate-enrichment label read) now gate their `bd show` spawn on `bdDoorGate`: in the box profile (`PRX_BEADS_DOOR`) they dial the door (the same path `prx beads show` uses) instead of execing a local `bd`; off-profile the gate returns null and the existing runner/`tryCommand` spawns exactly as before — byte-identical. Gating `hydrateBeads` here also keeps that bd read off `defaultRunner`'s GitHub rate-limit bucket, where it never belonged.

This is the dialer-backed `show` slice of prx-zbsi. The remaining ungated reads need a daemon read verb that does not yet exist (`bd dep list`/`bd query`/`bd children` for epic-children resolution — the door read surface is `ready`/`list`/`show` only) or are host-only workspace state (`bd config` watermarks, bucket B); both are tracked as prx-zbsi follow-ups.
