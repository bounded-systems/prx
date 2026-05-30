// Defensive: strip ```json … ``` wrapping that some models emit despite
// system-prompt instructions to the contrary. Used by triage verbs that
// JSON.parse a Haiku-emitted payload after `parseClaudeJsonEnvelope` unwrap.
export function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  return fenced ? (fenced[1] ?? text) : text;
}
