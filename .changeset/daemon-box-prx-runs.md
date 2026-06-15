---
"@bounded-systems/prx": patch
---

Fix the keeperd-box + beadsd-box images so prx actually runs (prx-hqqw). They put the fetched `bun --compile` release binary into a from-scratch image, where it couldn't execute (no `/lib` loader) and degraded to bare Bun, or — once the loader was found — crashed at startup with `ENOENT … uv_os_homedir`. Two fixes, mirroring the proven `claude-box` flake: (1) `nix/oci/prx-fhs.nix` wraps the **byte-intact** binary to invoke the nix glibc loader directly (`ld-linux-<arch>.so --library-path … /libexec/prx`) — patchelf corrupts the appended Bun blob, so the bytes must be left alone; (2) `dockerTools.fakeNss` + `HOME` give prx's `os.homedir()` (and dolt's user lookup) a `/etc/passwd` + writable home. Validated on podman: both daemons now start and bind their sockets (`keeperd: listening …`, `beadsd: listening …`).
