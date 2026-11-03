import { describe, expect, it } from 'vitest';
import { STRINGS } from '../i18n';
import { estimateTokens, formatReport, formatRow, savingPercent, type BenchRow } from './bench';

const ruT = STRINGS.ru;
const enT = STRINGS.en;

const row = (over: Partial<BenchRow> = {}): BenchRow => ({
  nodeId: '12:34',
  name: 'Header',
  type: 'FRAME',
  baselineChars: 40_000,
  parts: [
    { label: 'tree', chars: 2_000 },
    { label: 'text', chars: 1_000 },
    { label: 'inspect', chars: 1_000 },
  ],
  ...over,
});

describe('bench', () => {
  it('estimates tokens as chars/4 rounded up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(5)).toBe(2);
  });

  it('computes saving percent', () => {
    expect(savingPercent(40_000, 4_000)).toBe(90);
    expect(savingPercent(1_000, 1_500)).toBe(-50);
    expect(savingPercent(undefined, 10)).toBeNull();
  });

  it('formats a row with breakdown', () => {
    expect(formatRow(row(), ruT)).toBe(
      '12:34 FRAME "Header": REST JSON 10 000 ток. → DSL 1 000 ток. (−90%) [tree 500 · text 250 · inspect 250]',
    );
  });

  it('shows growth with plus sign and missing baseline', () => {
    expect(formatRow(row({ baselineChars: 2_000 }), ruT)).toContain('(+100%)');
    expect(formatRow(row({ baselineChars: undefined, baselineError: 'TIMEOUT' }), ruT)).toContain(
      'REST JSON недоступен (TIMEOUT)',
    );
  });

  it('adds a total line for several nodes only', () => {
    expect(formatReport([row()], ruT)).not.toContain('ИТОГО');
    const r = formatReport([row(), row({ nodeId: '1:1', baselineChars: 8_000 })], ruT);
    expect(r).toContain('ИТОГО: REST JSON 12 000 ток. → DSL 2 000 ток. (−83%)');
  });
});

describe('bench report in English', () => {
  it('uses the English dictionary', () => {
    const r = formatReport([row(), row({ nodeId: '1:1', baselineChars: 8_000 })], enT);
    expect(r).toContain('# Token benchmark');
    expect(r).toContain('TOTAL: REST JSON 12 000 tok. → DSL 2 000 tok. (−83%)');
    expect(formatRow(row({ baselineChars: undefined }), enT)).toContain('REST JSON unavailable (no data)');
  });
});
