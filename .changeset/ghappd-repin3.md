---
"@bounded-systems/prx": patch
---

Repin ghappd-room to ghappd-box sha256:d14a68c8… — the rebuild baking the released prx v0.17.1, which carries the `ghapp serve` CLI route (#814). Verified: `ghapp serve --help` dispatches in this image. The prior pins baked v0.17.0 (pre-route) and crashed the door at deploy ("Unknown subcommand: ghapp"). With this digest, `prx pod up --recreate` brings the forge door up on :9998.
