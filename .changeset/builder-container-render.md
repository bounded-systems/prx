---
"@bounded-systems/prx": patch
---

Add the container-builder render core (prx-zj8): pure, tested functions that
render the `podman run` argv for the `nix-builder-box` container, its
`/etc/nix/machines` registration line, and the ssh-config alias
(packages/prx/src/builder/container-builder.ts). This is the verified mechanics
the builder cutover (register the container as the host's nix remote builder,
retire the Lima builder) drives; the live `prx builder` CLI lands with the
cutover where it's exercised end-to-end.
