/**
 * File-backed session store (session-substrate slice 3).
 *
 * The durable {@link ./handler.SessionStore}: one JSON file per session at
 * `<dir>/<id>.json`. The store is the source of truth for WHICH sessions exist,
 * so it must outlive the daemon — a restart re-reads the files and the handler
 * reconciles each against liveness. (The in-memory store from slice 1 stays the
 * test/reference impl; this is the one the in-VM daemon runs on.)
 *
 * Reads validate against the wire contract
 * ({@link ./contract.SessionRecordSchema}), so a truncated/corrupt/foreign file
 * is treated as absent rather than handed back as a malformed record. Session
 * ids are contract-constrained to `[A-Za-z0-9._-]+` (no `/`), so `<id>.json`
 * can't escape `dir`.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SessionRecordSchema, type SessionRecord } from "./contract.ts";
import { type SessionStore } from "./handler.ts";

const SUFFIX = ".json";

/** A {@link SessionStore} persisting one `<id>.json` per session under `dir`. */
export function createFileSessionStore(dir: string): SessionStore {
  mkdirSync(dir, { recursive: true });
  const pathFor = (id: string): string => join(dir, `${id}${SUFFIX}`);

  const readRecord = (file: string): SessionRecord | undefined => {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined; // missing or unparsable → treat as absent
    }
    const result = SessionRecordSchema.safeParse(json);
    return result.success ? result.data : undefined;
  };

  return {
    put: (record) => {
      // Validate before persisting so a bad record never reaches disk.
      const valid = SessionRecordSchema.parse(record);
      writeFileSync(pathFor(valid.id), `${JSON.stringify(valid)}\n`, "utf8");
    },
    get: (id) => readRecord(pathFor(id)),
    list: () =>
      readdirSync(dir)
        .filter((name) => name.endsWith(SUFFIX))
        .map((name) => readRecord(join(dir, name)))
        .filter((r): r is SessionRecord => r !== undefined),
    delete: (id) => rmSync(pathFor(id), { force: true }),
  };
}
