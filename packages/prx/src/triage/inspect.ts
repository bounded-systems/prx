// Stately inspector wiring for the triage machine. Off by default; on with
// `--inspect`, the demo script (scripts/triage-machine-demo.ts) starts a
// local WebSocket bridge via `@statelyai/inspect/server` and pipes machine
// events through `@statelyai/inspect`'s `createWebSocketInspector`. The
// browser auto-opens to inspect.statelyai for live state-graph rendering.
//
// This module exposes a thin wrapper so the demo doesn't have to know which
// adapter we picked. When `enabled: false`, returns `null`; the demo passes
// `null` straight through to `createActor(machine, { inspect: undefined })`.

import { createWebSocketInspector } from "@statelyai/inspect";
import { createInspectorServer } from "@statelyai/inspect/server";

export type TriageInspectorHandle = {
  inspect: ReturnType<typeof createWebSocketInspector>["inspect"];
  stop: () => void;
};

export function createTriageInspector(opts: {
  enabled: boolean;
  port?: number;
  autoOpen?: boolean;
}): TriageInspectorHandle | null {
  if (!opts.enabled) return null;
  const port = opts.port ?? 8080;
  const server = createInspectorServer({
    port,
    autoOpen: opts.autoOpen ?? true,
  });
  const inspector = createWebSocketInspector({
    url: `ws://localhost:${port}`,
  });
  inspector.start();
  return {
    inspect: inspector.inspect,
    stop: () => {
      inspector.stop();
      server.stop();
    },
  };
}
