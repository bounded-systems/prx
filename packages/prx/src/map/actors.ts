// XState `fromPromise` actors that wrap each `prx map` verb (GH-2016 PR-1).
//
// Real actors: `createActor`, `showActor`. Stub actors: `nextActor`,
// `syncActor` — both reject with `MapStubError` so the machine's `onError`
// transition lands the run in `failed` with the blocking ticket in context.
// The PR-2 / PR-3 children of GH-2016 swap each stub for the real verb.

import { fromPromise } from "xstate";

import { runMapCreate, type MapCreateActorResult, type MapCreateOptions } from "./create.ts";
import { runMapShow, type MapShowActorResult, type MapShowOptions } from "./show.ts";
import { runMapNext, type MapNextActorResult, type MapNextOptions } from "./next.ts";
import { runMapSync, type MapSyncActorResult, type MapSyncOptions } from "./sync.ts";

export const createActor = fromPromise<MapCreateActorResult, MapCreateOptions>(async ({ input }) =>
  runMapCreate(input),
);

export const showActor = fromPromise<MapShowActorResult, MapShowOptions>(async ({ input }) =>
  runMapShow(input),
);

export const nextActor = fromPromise<MapNextActorResult, MapNextOptions>(async ({ input }) =>
  runMapNext(input),
);

export const syncActor = fromPromise<MapSyncActorResult, MapSyncOptions>(async ({ input }) =>
  runMapSync(input),
);

export { MapStubError } from "./sync.ts";
