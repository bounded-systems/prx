---
"@bounded-systems/prx": patch
---

Pass `--socket` and `--key` CMD args to keeperd container so it binds to the shared fabric.

The keeperd image entrypoint hardcodes `--socket /run/doors/keeperd.sock --key /keys/keeper.key`
before `"$@"`. door-kit's `parseArgs` uses last-wins semantics, so CMD args (after the OCI image
ref in `podman run`) override the baked-in defaults.

- **spec.ts** — `RoomSpec` gains `extraArgs: string[]` (default `[]`): room-specific CMD args
  appended after the image ref for entrypoint override
- **podman.ts** — `renderPodmanRun` appends `--socket ${doorDir}/<basename>` CMD args for each
  exposed door (overrides hardcoded entrypoint socket path), then `room.extraArgs`
- **keeperd-room.ts** — sets `extraArgs: ["--key", "/run/secrets/keeper-key"]` to override the
  entrypoint's baked-in key path with our secret mount target
- all existing room definitions gain `extraArgs: []` to satisfy the TS output type
