// Dev benchmark of token savings (docs/benchmark.md). Pure functions, covered by unit tests.

/** Rough estimate: ~4 characters per token. Same formula on both sides: the relative difference matters. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export interface BenchPart {
  label: string;
  chars: number;
  error?: string;
}

export interface BenchRow {
  nodeId: string;
  name: string;
  type: string;
  baselineChars?: number;
  baselineError?: string;
  parts: BenchPart[];
}

/** Report strings (a subset of the UI dictionary). */
export interface BenchStrings {
  reportTitle: string;
  reportEstimate: string;
  tokens: string;
  restUnavailable: string;
  noData: string;
  total: string;
}

const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function ourChars(row: BenchRow): number {
  return row.parts.reduce((sum, p) => sum + p.chars, 0);
}

/** Savings in percent (positive: the DSL is smaller), null without a baseline. */
export function savingPercent(baselineChars: number | undefined, ours: number): number | null {
  if (!baselineChars) return null;
  return Math.round((1 - ours / baselineChars) * 100);
}

export function formatRow(row: BenchRow, t: BenchStrings): string {
  const ours = ourChars(row);
  const parts = row.parts
    .map((p) => `${p.label} ${p.error ? 'ERR' : fmt(estimateTokens(p.chars))}`)
    .join(' · ');
  const head = `${row.nodeId} ${row.type} "${row.name}"`;
  if (row.baselineChars === undefined) {
    return `${head}: ${t.restUnavailable} (${row.baselineError ?? t.noData}) → DSL ${fmt(estimateTokens(ours))} ${t.tokens} [${parts}]`;
  }
  const pct = savingPercent(row.baselineChars, ours);
  return (
    `${head}: REST JSON ${fmt(estimateTokens(row.baselineChars))} ${t.tokens} → DSL ${fmt(estimateTokens(ours))} ${t.tokens} ` +
    `(${pct !== null && pct >= 0 ? '−' : '+'}${Math.abs(pct ?? 0)}%) [${parts}]`
  );
}

/** Final report to copy (paste into a chat with the agent / an issue). */
export function formatReport(rows: BenchRow[], t: BenchStrings): string {
  const lines = [t.reportTitle, t.reportEstimate];
  lines.push(...rows.map((r) => formatRow(r, t)));
  const measured = rows.filter((r) => r.baselineChars !== undefined);
  if (measured.length > 1) {
    const base = measured.reduce((s, r) => s + (r.baselineChars ?? 0), 0);
    const ours = measured.reduce((s, r) => s + ourChars(r), 0);
    lines.push(
      `${t.total}: REST JSON ${fmt(estimateTokens(base))} ${t.tokens} → DSL ${fmt(estimateTokens(ours))} ${t.tokens} (−${savingPercent(base, ours)}%)`,
    );
  }
  return lines.join('\n');
}
