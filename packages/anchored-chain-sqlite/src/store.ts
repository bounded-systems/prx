import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

// GH-245: embed the migrations so a `bun build --compile` binary (where the
// on-disk ./migrations folder is absent) can still initialize the schema. The
// dev/install path uses the folder directly; only the compiled path materializes
// these. Adding a migration means adding its import + EMBEDDED_MIGRATION_SQL entry.
import journal from './migrations/meta/_journal.json' with { type: 'json' };
import sql0000init from './migrations/0000_init.sql' with { type: 'text' };
import sql0001watchers from './migrations/0001_tiresome_the_watchers.sql' with { type: 'text' };

const EMBEDDED_MIGRATION_SQL: Record<string, string> = {
  '0000_init': sql0000init,
  '0001_tiresome_the_watchers': sql0001watchers,
};

import type {
  AnchoredChainStore,
  DerivationInputRow,
  DerivationOutputRow,
  DerivationStore,
  RefStore,
  Derivation,
  Digest,
  Ref,
  RefLogEntry,
} from '@bounded-systems/anchored-chain';
import { RefMismatchError } from '@bounded-systems/anchored-chain';
import {
  derivationInputs,
  derivationOutputs,
  derivations,
  refLog,
  refs,
  schema,
} from './schema.ts';

export function openAnchoredChain(path: string = ':memory:'): AnchoredChainStore {
  const sqlite = new Database(path, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });

  const casUpdate = sqlite.prepare(
    'UPDATE refs SET digest = ?, updated_at = ? WHERE name = ? AND digest = ?',
  );
  const casInsert = sqlite.prepare(
    'INSERT INTO refs (name, digest, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING',
  );
  const refLogInsert = sqlite.prepare(
    'INSERT INTO ref_log (name, prev_digest, new_digest, reason, ts) VALUES (?, ?, ?, ?, ?)',
  );
  const selectRefRow = sqlite.prepare(
    'SELECT name, digest, updated_at FROM refs WHERE name = ?',
  );

  type CasArgs = {
    name: string;
    prevDigest: Digest | null;
    newDigest: Digest;
    reason: string;
    ts: number;
  };

  const casTransaction = sqlite.transaction((args: CasArgs): Ref => {
    if (args.prevDigest === null) {
      const result = casInsert.run(args.name, args.newDigest, args.ts);
      if (result.changes === 0) {
        const row = selectRefRow.get(args.name) as
          | { digest: string }
          | null;
        throw new RefMismatchError({
          refName: args.name,
          expectedPrev: null,
          actual: (row?.digest ?? null) as Digest | null,
        });
      }
    } else {
      const result = casUpdate.run(
        args.newDigest,
        args.ts,
        args.name,
        args.prevDigest,
      );
      if (result.changes === 0) {
        const row = selectRefRow.get(args.name) as
          | { digest: string }
          | null;
        throw new RefMismatchError({
          refName: args.name,
          expectedPrev: args.prevDigest,
          actual: (row?.digest ?? null) as Digest | null,
        });
      }
    }
    refLogInsert.run(
      args.name,
      args.prevDigest,
      args.newDigest,
      args.reason,
      args.ts,
    );
    return { name: args.name, digest: args.newDigest, ts: args.ts };
  });

  const refStore: RefStore = {
    async get(name) {
      const row = await db
        .select()
        .from(refs)
        .where(eq(refs.name, name))
        .limit(1)
        .all();
      const first = row[0];
      if (!first) return null;
      return {
        name: first.name,
        digest: first.digest as Digest,
        ts: first.updatedAt,
      };
    },
    async cas(args) {
      return casTransaction.immediate(args);
    },
    async asOf(name, ts) {
      const row = await db
        .select()
        .from(refLog)
        .where(and(eq(refLog.name, name), lte(refLog.ts, ts)))
        .orderBy(desc(refLog.ts))
        .limit(1)
        .all();
      const first = row[0];
      if (!first) return null;
      return rowToRefLogEntry(first);
    },
    async log(name) {
      const rows = await db
        .select()
        .from(refLog)
        .where(eq(refLog.name, name))
        .orderBy(asc(refLog.ts))
        .all();
      return rows.map(rowToRefLogEntry);
    },
  };

  const derivationStore: DerivationStore = {
    async append(derivation) {
      const manifestJson = JSON.stringify(derivation.manifest);
      const envelopeJson =
        derivation.envelope === undefined
          ? null
          : JSON.stringify(derivation.envelope);
      db.transaction((tx) => {
        tx.insert(derivations)
          .values({
            derivationId: derivation.derivationId,
            producer: derivation.manifest.producer,
            manifestJson,
            envelopeJson,
            ts: derivation.ts,
          })
          .run();
        for (const [inputName, inputDigest] of Object.entries(
          derivation.manifest.inputs,
        )) {
          tx.insert(derivationInputs)
            .values({
              derivationId: derivation.derivationId,
              inputName,
              inputDigest,
            })
            .run();
        }
        for (const [outputName, outputDigest] of Object.entries(
          derivation.manifest.outputs,
        )) {
          tx.insert(derivationOutputs)
            .values({
              derivationId: derivation.derivationId,
              outputName,
              outputDigest,
            })
            .run();
        }
      });
    },
    async get(derivationId) {
      const row = await db
        .select()
        .from(derivations)
        .where(eq(derivations.derivationId, derivationId))
        .limit(1)
        .all();
      const first = row[0];
      if (!first) return null;
      const manifest = JSON.parse(first.manifestJson) as Derivation['manifest'];
      const envelope =
        first.envelopeJson === null
          ? undefined
          : (JSON.parse(first.envelopeJson) as Derivation['envelope']);
      return {
        derivationId: first.derivationId as Digest,
        manifest,
        ...(envelope === undefined ? {} : { envelope }),
        ts: first.ts,
      };
    },
    async listInputs(derivationId) {
      const rows = await db
        .select()
        .from(derivationInputs)
        .where(eq(derivationInputs.derivationId, derivationId))
        .all();
      return rows.map(
        (r): DerivationInputRow => ({
          inputName: r.inputName,
          inputDigest: r.inputDigest as Digest,
        }),
      );
    },
    async listOutputs(derivationId) {
      const rows = await db
        .select()
        .from(derivationOutputs)
        .where(eq(derivationOutputs.derivationId, derivationId))
        .all();
      return rows.map(
        (r): DerivationOutputRow => ({
          outputName: r.outputName,
          outputDigest: r.outputDigest as Digest,
        }),
      );
    },
    async derivationsByOutput(outputDigest) {
      // Indexed by `derivation_outputs_digest`. A derivation that emits the same
      // digest under two output names yields two rows, so de-dupe the ids.
      const rows = await db
        .select({ derivationId: derivationOutputs.derivationId })
        .from(derivationOutputs)
        .where(eq(derivationOutputs.outputDigest, outputDigest))
        .all();
      const seen = new Set<string>();
      const ids: Digest[] = [];
      for (const r of rows) {
        if (seen.has(r.derivationId)) continue;
        seen.add(r.derivationId);
        ids.push(r.derivationId as Digest);
      }
      return ids;
    },
  };

  const descendantsCte = sqlite.prepare(`
    WITH RECURSIVE walk(derivation_id) AS (
      SELECT derivation_id FROM derivation_inputs WHERE input_digest = ?
      UNION
      SELECT di.derivation_id
        FROM derivation_inputs di
        JOIN derivation_outputs dout
          ON di.input_digest = dout.output_digest
        JOIN walk w
          ON w.derivation_id = dout.derivation_id
    )
    SELECT derivation_id FROM walk
  `);

  const lineageDescendantsCte = sqlite.prepare(`
    WITH RECURSIVE walk(derivation_id) AS (
      SELECT di.derivation_id
        FROM derivation_outputs dout
        JOIN derivation_inputs di
          ON di.input_digest = dout.output_digest
       WHERE dout.derivation_id = ?
      UNION
      SELECT di.derivation_id
        FROM derivation_inputs di
        JOIN derivation_outputs dout
          ON di.input_digest = dout.output_digest
        JOIN walk w
          ON w.derivation_id = dout.derivation_id
    )
    SELECT derivation_id FROM walk
  `);

  const lineageAncestorsCte = sqlite.prepare(`
    WITH RECURSIVE walk(derivation_id) AS (
      SELECT dout.derivation_id
        FROM derivation_inputs di
        JOIN derivation_outputs dout
          ON di.input_digest = dout.output_digest
       WHERE di.derivation_id = ?
      UNION
      SELECT dout.derivation_id
        FROM derivation_inputs di
        JOIN derivation_outputs dout
          ON di.input_digest = dout.output_digest
        JOIN walk w
          ON w.derivation_id = di.derivation_id
    )
    SELECT derivation_id FROM walk
  `);

  const invalidate = {
    async descendants(movedDigest: Digest): Promise<Digest[]> {
      const rows = descendantsCte.all(movedDigest) as Array<{
        derivation_id: string;
      }>;
      return rows.map((r) => r.derivation_id as Digest);
    },
  };

  const lineage = {
    async ancestors(derivationId: Digest): Promise<Digest[]> {
      const rows = lineageAncestorsCte.all(derivationId) as Array<{
        derivation_id: string;
      }>;
      return rows.map((r) => r.derivation_id as Digest);
    },
    async descendants(derivationId: Digest): Promise<Digest[]> {
      const rows = lineageDescendantsCte.all(derivationId) as Array<{
        derivation_id: string;
      }>;
      return rows.map((r) => r.derivation_id as Digest);
    },
    async isStale(
      derivationId: Digest,
      currentRefs: Readonly<Record<string, Digest>>,
    ): Promise<boolean> {
      const inputs = await derivationStore.listInputs(derivationId);
      for (const { inputName, inputDigest } of inputs) {
        const current = currentRefs[inputName];
        if (current === undefined) continue;
        if (current !== inputDigest) return true;
      }
      return false;
    },
  };

  return {
    refs: refStore,
    derivations: derivationStore,
    invalidate,
    lineage,
    close() {
      sqlite.close();
    },
  };
}

/**
 * Resolve drizzle's migrations folder. In dev / a normal install the on-disk
 * ./migrations folder exists and is used directly (drizzle's migrator + its
 * migration tracking, unchanged). In a `bun build --compile` binary that folder
 * isn't on disk, so materialize the EMBEDDED migrations to a temp dir in
 * drizzle's expected layout (meta/_journal.json + <tag>.sql) and use that. GH-245.
 */
function resolveMigrationsFolder(): string {
  const onDisk = fileURLToPath(new URL('./migrations', import.meta.url));
  if (existsSync(join(onDisk, 'meta', '_journal.json'))) return onDisk;
  const dir = mkdtempSync(join(tmpdir(), 'acs-migrations-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries) {
    const sql = EMBEDDED_MIGRATION_SQL[entry.tag];
    if (sql === undefined) {
      throw new Error(`anchored-chain: no embedded migration for '${entry.tag}'`);
    }
    writeFileSync(join(dir, `${entry.tag}.sql`), sql);
  }
  return dir;
}

function rowToRefLogEntry(row: {
  name: string;
  prevDigest: string | null;
  newDigest: string;
  reason: string;
  ts: number;
}): RefLogEntry {
  return {
    name: row.name,
    prevDigest: (row.prevDigest ?? null) as Digest | null,
    newDigest: row.newDigest as Digest,
    reason: row.reason,
    ts: row.ts,
  };
}
