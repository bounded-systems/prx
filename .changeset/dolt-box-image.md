---
"@bounded-systems/prx": minor
---

Add the `dolt-box` OCI image (prx-zj8) — the per-repo dolt SQL server as a pinned `dockerTools.streamLayeredImage`, the third OCI fleet image after beadsd-box and keeperd-box. Runs a standalone `dolt sql-server` on `3307/tcp` (the MySQL wire protocol beadsd-box's dolt client reaches over the pod network — connect-to-external-dolt). The dolt database is a **named volume** at `$DOLT_DATA_DIR` (default `/var/lib/dolt`), never baked into a layer; the pod (prx-asr) supplies it. Build on the prx-62h linux builder: `nix build .#packages.aarch64-linux.dolt-box`. Note for prx-asr: today `prx dolt start` delegates to `bd dolt start` (bd owns the co-located lifecycle); the pod model inverts this so dolt-box owns the server and beadsd's bd connects to it externally — wiring that decoupling is prx-asr's job.
