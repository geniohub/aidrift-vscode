// Trigram Jaccard similarity — used to detect when the model repeats the
// same failed output. Noisy heuristic (boilerplate-heavy responses false-
// positive), but zero-cost and swappable for embeddings later.
//
// Inlined from @aidrift/core at the time of the aidrift-vscode extraction
// (2026-04-21) so this repo has zero dependency on the monorepo.

export function trigrams(s: string): Set<string> {
  const normalized = `  ${s.toLowerCase().replace(/\s+/g, " ").trim()}  `;
  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function similarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}
