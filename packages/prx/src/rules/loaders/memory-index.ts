// GH-1423: stub loader for memory-index.
//
// PR-1 returns `[]`. The real loader (follow-up) parses the project-level
// `MEMORY.md` index.

import {
  type MemoryIndex,
  memoryIndexSchema,
} from "../schemas/inputs.ts";

export const MEMORY_INDEX_STUB_TICKET = "GH-1423/follow-up/memory-index";

export function loadMemoryIndexStub(): MemoryIndex {
  return memoryIndexSchema.parse([]);
}
