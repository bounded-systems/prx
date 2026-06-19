import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const refs = sqliteTable("refs", {
  name: text("name").primaryKey(),
  digest: text("digest").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const refLog = sqliteTable(
  "ref_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    prevDigest: text("prev_digest"),
    newDigest: text("new_digest").notNull(),
    reason: text("reason").notNull(),
    ts: integer("ts").notNull(),
  },
  (t) => ({
    refLogNameTs: index("ref_log_name_ts").on(t.name, t.ts),
  }),
);

export const derivations = sqliteTable("derivations", {
  derivationId: text("derivation_id").primaryKey(),
  producer: text("producer").notNull(),
  manifestJson: text("manifest_json").notNull(),
  // Nullable DSSE envelope (in-toto Statement, base64 payload + signatures).
  // Null = unsigned derivation; present = signed provenance. See
  // docs/anchored-chain/in-toto-alignment-plan.md (Phase 1).
  envelopeJson: text("envelope_json"),
  ts: integer("ts").notNull(),
});

export const derivationInputs = sqliteTable(
  "derivation_inputs",
  {
    derivationId: text("derivation_id")
      .notNull()
      .references(() => derivations.derivationId),
    inputName: text("input_name").notNull(),
    inputDigest: text("input_digest").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.derivationId, t.inputName] }),
    inputDigestIdx: index("derivation_inputs_digest").on(t.inputDigest),
  }),
);

export const derivationOutputs = sqliteTable(
  "derivation_outputs",
  {
    derivationId: text("derivation_id")
      .notNull()
      .references(() => derivations.derivationId),
    outputName: text("output_name").notNull(),
    outputDigest: text("output_digest").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.derivationId, t.outputName] }),
    outputDigestIdx: index("derivation_outputs_digest").on(t.outputDigest),
  }),
);

export const schema = {
  refs,
  refLog,
  derivations,
  derivationInputs,
  derivationOutputs,
};
