/**
 * Schema-aware structured-body parser (GH-1359).
 *
 * Splits an intake-body string on the canonical H2 headings declared in
 * `INTAKE_BODY_FIELDS_META[type]` and returns a `{ fields, unparsed }`
 * pair. Recognised H2 sections route into `fields[canonical_name]`;
 * unrecognised H2 sections and pre-H2 prose accumulate in `unparsed`.
 *
 * The parser is intentionally minimal: it does not parse markdown
 * structure beyond recognising H2 headings on their own line. Headings
 * whose text matches a canonical heading — case-insensitive, with
 * trailing whitespace and trailing `.`/`:` characters stripped before
 * comparison — are treated as section boundaries; everything else is
 * preserved verbatim.
 *
 * The round-trip property `parseStructuredBody(composeStructuredBody(f),
 * t).fields === f` holds for any field map whose values do not
 * themselves contain H2-shaped lines.
 */

import { INTAKE_BODY_FIELDS_META, type IntakeBodySchemaType } from "./fields_meta.ts";

export type ParsedStructuredBody = {
  /** Recognised section content keyed by canonical schema field name. */
  fields: Partial<Record<string, string>>;
  /** Pre-H2 prose plus any H2 sections whose heading is not in the schema. */
  unparsed: string;
};

const HEADING_RE = /^##\s+(.+?)\s*$/;

function normalizeHeading(text: string): string {
  return text.replace(/[:.\s]+$/, "").trim().toLowerCase();
}

function trimSectionContent(content: string): string {
  return content.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
}

export function parseStructuredBody(
  body: string,
  type: IntakeBodySchemaType,
): ParsedStructuredBody {
  const meta = INTAKE_BODY_FIELDS_META[type];
  const headingToField = new Map<string, string>();
  for (const [field, fieldMeta] of Object.entries(meta)) {
    headingToField.set(normalizeHeading(fieldMeta.heading), field);
  }

  const fields: Partial<Record<string, string>> = {};
  const unparsedSections: string[] = [];
  const lines = body.split("\n");

  let currentField: string | null = null;
  let currentUnparsedHeading: string | null = null;
  let currentContent: string[] = [];

  const flush = () => {
    const text = trimSectionContent(currentContent.join("\n"));
    if (currentField !== null) {
      fields[currentField] = text;
    } else if (currentUnparsedHeading !== null) {
      unparsedSections.push(text.length > 0 ? `${currentUnparsedHeading}\n\n${text}` : currentUnparsedHeading);
    } else if (text.length > 0) {
      unparsedSections.push(text);
    }
    currentField = null;
    currentUnparsedHeading = null;
    currentContent = [];
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flush();
      const rawHeading = match[1]!;
      const fieldName = headingToField.get(normalizeHeading(rawHeading));
      if (fieldName) {
        currentField = fieldName;
      } else {
        currentUnparsedHeading = `## ${rawHeading}`;
      }
      continue;
    }
    currentContent.push(line);
  }
  flush();

  return { fields, unparsed: unparsedSections.join("\n\n") };
}
