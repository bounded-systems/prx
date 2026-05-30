// GH-1768 — minimal in-process Horn-clause evaluator.
//
// Naive saturation with stratified negation. Sized for the spike's rule
// catalog (~20 rules across 5 use cases); not a general-purpose engine.
// If complexity exceeds the spike budget we swap to `datascript` — that
// swap is a finding for the retro, not a scope expansion.

export type Constant = string | number | boolean | null;
export type Term = { kind: "var"; name: string } | { kind: "const"; value: Constant };

export type Atom = {
  relation: string;
  args: Term[];
  negated?: boolean;
};

export type Rule = {
  name: string;
  head: { relation: string; args: Term[] };
  body: Atom[];
};

export type Fact = { relation: string; args: Constant[] };

export function v(name: string): Term {
  return { kind: "var", name };
}

export function c(value: Constant): Term {
  return { kind: "const", value };
}

export function atom(relation: string, ...args: Term[]): Atom {
  return { relation, args };
}

export function not(a: Atom): Atom {
  return { relation: a.relation, args: a.args, negated: true };
}

export function rule(name: string, head: Atom, body: Atom[]): Rule {
  return { name, head: { relation: head.relation, args: head.args }, body };
}

export function fact(relation: string, ...args: Constant[]): Fact {
  return { relation, args };
}

export function factKey(f: Fact): string {
  return `${f.relation}(${f.args.map((a) => JSON.stringify(a)).join(",")})`;
}

function argsKey(args: Constant[]): string {
  return args.map((a) => JSON.stringify(a)).join(",");
}

export class FactSet {
  private byRelation = new Map<string, Map<string, Constant[]>>();

  add(f: Fact): boolean {
    let bucket = this.byRelation.get(f.relation);
    if (!bucket) {
      bucket = new Map();
      this.byRelation.set(f.relation, bucket);
    }
    const key = argsKey(f.args);
    if (bucket.has(key)) return false;
    bucket.set(key, f.args);
    return true;
  }

  has(relation: string, args: Constant[]): boolean {
    return this.byRelation.get(relation)?.has(argsKey(args)) ?? false;
  }

  *iter(relation: string): IterableIterator<Constant[]> {
    const bucket = this.byRelation.get(relation);
    if (!bucket) return;
    for (const args of bucket.values()) yield args;
  }

  all(): Fact[] {
    const out: Fact[] = [];
    for (const [relation, bucket] of this.byRelation) {
      for (const args of bucket.values()) {
        out.push({ relation, args });
      }
    }
    out.sort((a, b) => factKey(a).localeCompare(factKey(b)));
    return out;
  }

  get(relation: string): Fact[] {
    const bucket = this.byRelation.get(relation);
    if (!bucket) return [];
    const out: Fact[] = [];
    for (const args of bucket.values()) out.push({ relation, args });
    return out;
  }
}

export type Derivation = { rule: string; premises: string[] };
export type Provenance = Map<string, Derivation[]>;

export type EvaluationResult = {
  facts: FactSet;
  provenance: Provenance;
  rounds: number;
};

type Binding = Map<string, Constant>;

function unify(terms: Term[], args: Constant[], binding: Binding): Binding | null {
  if (terms.length !== args.length) return null;
  let out: Binding | null = null;
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i]!;
    const a = args[i]!;
    if (t.kind === "const") {
      if (t.value !== a) return null;
    } else {
      const existing = (out ?? binding).get(t.name);
      if (existing === undefined) {
        if (!out) out = new Map(binding);
        out.set(t.name, a);
      } else if (existing !== a) {
        return null;
      }
    }
  }
  return out ?? binding;
}

function groundTerm(t: Term, binding: Binding): Constant | undefined {
  return t.kind === "const" ? t.value : binding.get(t.name);
}

function* evaluateBody(body: Atom[], db: FactSet, binding: Binding): IterableIterator<Binding> {
  if (body.length === 0) {
    yield binding;
    return;
  }
  const [first, ...rest] = body;
  if (!first) {
    yield binding;
    return;
  }
  if (first.negated) {
    // Stratified-negation contract: by the time a negated atom is
    // evaluated, every fact for its relation already exists in the DB.
    // Existential semantics: unbound variables in the negation scan all
    // facts; if any matches the bound terms, the negation fails.
    let found = false;
    for (const args of db.iter(first.relation)) {
      const m = unify(first.args, args, binding);
      if (m) {
        found = true;
        break;
      }
    }
    if (!found) yield* evaluateBody(rest, db, binding);
    return;
  }
  for (const args of db.iter(first.relation)) {
    const m = unify(first.args, args, binding);
    if (m) yield* evaluateBody(rest, db, m);
  }
}

function stratify(rules: Rule[]): Rule[][] {
  const rels = new Set<string>();
  const posDeps = new Map<string, Set<string>>();
  const negDeps = new Map<string, Set<string>>();
  for (const r of rules) {
    rels.add(r.head.relation);
    if (!posDeps.has(r.head.relation)) posDeps.set(r.head.relation, new Set());
    if (!negDeps.has(r.head.relation)) negDeps.set(r.head.relation, new Set());
    for (const a of r.body) {
      rels.add(a.relation);
      if (a.negated) negDeps.get(r.head.relation)!.add(a.relation);
      else posDeps.get(r.head.relation)!.add(a.relation);
    }
  }
  const stratum = new Map<string, number>();
  for (const r of rels) stratum.set(r, 0);
  const cap = (rels.size + 1) * 4;
  let changed = true;
  let iterations = 0;
  while (changed) {
    if (iterations++ > cap) {
      throw new Error("rules not stratifiable: recursion through negation");
    }
    changed = false;
    for (const r of rels) {
      let s = stratum.get(r) ?? 0;
      for (const dep of posDeps.get(r) ?? []) s = Math.max(s, stratum.get(dep) ?? 0);
      for (const dep of negDeps.get(r) ?? []) s = Math.max(s, (stratum.get(dep) ?? 0) + 1);
      if (s > (stratum.get(r) ?? 0)) {
        stratum.set(r, s);
        changed = true;
      }
    }
  }
  const groups = new Map<number, Rule[]>();
  for (const r of rules) {
    const s = stratum.get(r.head.relation) ?? 0;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(r);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)!);
}

export function evaluate(rules: Rule[], edb: Fact[]): EvaluationResult {
  const facts = new FactSet();
  const provenance: Provenance = new Map();
  for (const f of edb) {
    if (facts.add(f)) provenance.set(factKey(f), [{ rule: "<edb>", premises: [] }]);
  }
  const strata = stratify(rules);
  let rounds = 0;
  for (const stratum of strata) {
    let changed = true;
    let safety = 0;
    while (changed) {
      if (safety++ > 256) throw new Error("evaluation did not converge");
      changed = false;
      rounds++;
      for (const r of stratum) {
        for (const binding of evaluateBody(r.body, facts, new Map())) {
          const headArgs: Constant[] = [];
          let ok = true;
          for (const t of r.head.args) {
            const g = groundTerm(t, binding);
            if (g === undefined) {
              ok = false;
              break;
            }
            headArgs.push(g);
          }
          if (!ok) continue;
          const newFact: Fact = { relation: r.head.relation, args: headArgs };
          const premises: string[] = [];
          for (const a of r.body) {
            if (a.negated) continue;
            const ax: Constant[] = [];
            let pOk = true;
            for (const t of a.args) {
              const g = groundTerm(t, binding);
              if (g === undefined) {
                pOk = false;
                break;
              }
              ax.push(g);
            }
            if (!pOk) continue;
            premises.push(factKey({ relation: a.relation, args: ax }));
          }
          const key = factKey(newFact);
          const sig = `${r.name}|${premises.join(";")}`;
          const existing = provenance.get(key) ?? [];
          if (!existing.some((d) => `${d.rule}|${d.premises.join(";")}` === sig)) {
            existing.push({ rule: r.name, premises });
            provenance.set(key, existing);
          }
          if (facts.add(newFact)) changed = true;
        }
      }
    }
  }
  return { facts, provenance, rounds };
}

export type DerivationTree = {
  fact: string;
  rule: string;
  children: DerivationTree[];
  cycle?: boolean;
};

export function explain(
  provenance: Provenance,
  goal: Fact,
  options: { maxDepth?: number } = {},
): DerivationTree | null {
  const maxDepth = options.maxDepth ?? 64;
  const goalKey = factKey(goal);
  if (!provenance.has(goalKey)) return null;
  const seen = new Set<string>();
  const walk = (key: string, depth: number): DerivationTree => {
    if (depth > maxDepth) {
      return { fact: key, rule: "<depth-cap>", children: [] };
    }
    if (seen.has(key)) {
      return { fact: key, rule: "<cycle>", children: [], cycle: true };
    }
    seen.add(key);
    const derivs = provenance.get(key) ?? [];
    const head = derivs[0];
    if (!head) {
      return { fact: key, rule: "<missing>", children: [] };
    }
    const children = head.premises.map((p) => walk(p, depth + 1));
    seen.delete(key);
    return { fact: key, rule: head.rule, children };
  };
  return walk(goalKey, 0);
}

export function formatDerivationTree(tree: DerivationTree, indent: string = ""): string {
  const lines: string[] = [];
  const recur = (n: DerivationTree, prefix: string, isLast: boolean) => {
    const branch = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
    lines.push(`${prefix}${branch}${n.fact}  [${n.rule}]`);
    const nextPrefix = prefix + (prefix === "" ? "" : isLast ? "   " : "│  ");
    for (let i = 0; i < n.children.length; i++) {
      recur(n.children[i]!, nextPrefix, i === n.children.length - 1);
    }
  };
  recur(tree, indent, true);
  return lines.join("\n");
}
