---
"@bounded-systems/prx": patch
---

Repin ghappd-room to ghappd-box sha256:c6b0d636… — the rebuild carrying the `ghapp serve` CLI route (#814). The prior image (0b7d7be2) crashed the door daemon at deploy with "Unknown subcommand: ghapp". With this digest, `prx pod up` brings the forge door up.
