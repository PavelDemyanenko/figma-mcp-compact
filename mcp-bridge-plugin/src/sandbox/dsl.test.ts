import { describe, expect, it } from 'vitest';
import { compactEffects, escapeField, mergeRuns, styleOverview, minifySvg, nodeLine, pageLine, round2, transformInfo, textLine, toHex, topLevelNodes, treeLine, truncate, bbox } from './dsl';

describe('dsl', () => {
  it('truncates to N chars with ellipsis, keeps short strings', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('abc…');
    expect(truncate('😀😀😀', 2)).toBe('😀😀…');
  });

  it('escapes separators and newlines so a line stays single-line', () => {
    expect(escapeField('a|b\nc\\d')).toBe('a\\|b\\nc\\\\d');
  });

  it('formats tree lines with indent, childCount and truncated suffix', () => {
    const n = { id: '1:2', name: 'Header', type: 'FRAME' };
    expect(treeLine(n, 0, 0)).toBe('1:2|Header|FRAME|0');
    expect(treeLine(n, 2, 50)).toBe('    1:2|Header|FRAME|50');
    expect(treeLine(n, 1, 73)).toBe('  1:2|Header|FRAME|73|truncated:23');
  });

  it('cuts names at 80 chars', () => {
    const line = nodeLine({ id: '1:1', name: 'x'.repeat(81), type: 'TEXT' });
    expect(line).toBe(`1:1|${'x'.repeat(80)}…|TEXT`);
  });

  it('formats text lines with slash path and 200-char text', () => {
    expect(textLine('3:4', ['Card', 'Title'], 'Hello\nworld')).toBe('3:4|Card/Title|Hello\\nworld');
    expect(textLine('3:4', [], 'y'.repeat(201)).endsWith('y…')).toBe(true);
  });

  it('converts colors to short hex, alpha only when < 1', () => {
    expect(toHex({ r: 0.1, g: 0.5, b: 0.9 })).toBe('#1a80e6');
    expect(toHex({ r: 1, g: 1, b: 1 }, 0.5)).toBe('#ffffff80');
  });

  it('rounds bbox', () => {
    expect(bbox({ x: 1.4, y: 2.6, width: 10.5, height: 0.2 })).toEqual([1, 3, 11, 0]);
  });

  it('keeps only top-level selection nodes', () => {
    const page = { id: '0:1', parent: null };
    const a = { id: 'a', parent: page };
    const b = { id: 'b', parent: a };
    const c = { id: 'c', parent: { id: 'x', parent: b } };
    const d = { id: 'd', parent: page };
    expect(topLevelNodes([a, b, c, d]).map((n) => n.id)).toEqual(['a', 'd']);
  });
});

describe('mergeRuns', () => {
  it('merges adjacent runs with identical style, keeps different ones', () => {
    const a = { font: 'Roboto Medium', size: 14 };
    const b = { font: 'Roboto Bold', size: 14 };
    expect(
      mergeRuns([
        { text: 'NORMA', style: a },
        { text: 'L', style: { ...a } },
        { text: '!', style: b },
        { text: '?', style: a },
      ]),
    ).toEqual([
      { text: 'NORMAL', style: a },
      { text: '!', style: b },
      { text: '?', style: a },
    ]);
  });
});

describe('transformInfo', () => {
  const ident = [[1, 0, 0], [0, 1, 0]] as const;
  it('returns null for untransformed nodes', () => {
    expect(
      transformInfo({ x: 10, y: 20, rotation: 0, relativeTransform: ident, absoluteTransform: ident, absoluteBoundingBox: null }),
    ).toBeNull();
  });

  it('detects vertical flip and computes visual bbox in parent coordinates', () => {
    // A 146x157 node flipped vertically: the anchor (69,223) is the bottom-left corner of the visible area.
    const flipY = [[1, 0, 69], [0, -1, 223]] as const;
    const absFlipY = [[1, 0, 1069], [0, -1, 1223]] as const; // parent offset by (1000, 1000)
    expect(
      transformInfo({
        x: 69,
        y: 223,
        rotation: 0,
        relativeTransform: flipY,
        absoluteTransform: absFlipY,
        absoluteBoundingBox: { x: 1069, y: 1066, width: 146, height: 157 },
      }),
    ).toEqual({ flipped: true, visualBBox: [69, 66, 146, 157] });
  });

  it('normalizes rotation to 0..359', () => {
    const r = transformInfo({
      x: 0,
      y: 0,
      rotation: -90,
      relativeTransform: [[0, 1, 0], [-1, 0, 0]],
      absoluteTransform: [[0, 1, 0], [-1, 0, 0]],
      absoluteBoundingBox: null,
    });
    expect(r).toEqual({ rotation: 270 });
  });
});

describe('round2', () => {
  it('keeps two decimals', () => {
    expect(round2(71.82662200927734)).toBe(71.83);
    expect(round2(4.9535603523254395)).toBe(4.95);
    expect(round2(20)).toBe(20);
  });
});

describe('pages and svg', () => {
  it('formats page lines with current marker', () => {
    expect(pageLine({ id: '0:1', name: 'Cover' }, false)).toBe('0:1|Cover|PAGE');
    expect(pageLine({ id: '11:1833', name: 'Getting|started' }, true)).toBe('11:1833|Getting\\|started|PAGE|current');
  });

  it('minifies Figma SVG export', () => {
    const raw =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n' +
      '<path d="M12.0001 4L10.5901 5.41L16.1701 11H4V13H16.1701L10.5901 18.59L12.0001 20L20 12L12.0001 4Z" fill="#1D1B20"/>\n' +
      '</svg>\n';
    expect(minifySvg(raw)).toBe(
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 4L10.59 5.41L16.17 11H4V13H16.17L10.59 18.59L12 20L20 12L12 4Z" fill="#1D1B20"/></svg>',
    );
  });
});

describe('compactEffects', () => {
  const black = (a: number) => ({ r: 0, g: 0, b: 0, a });
  it('emits CSS-like shadows and blurs, skips hidden', () => {
    const effects = [
      { type: 'DROP_SHADOW', visible: true, color: black(0.3), offset: { x: 0, y: 1 }, radius: 3, spread: 1, blendMode: 'NORMAL' },
      { type: 'INNER_SHADOW', visible: true, color: black(0.15), offset: { x: 0, y: 2 }, radius: 6.333333, blendMode: 'NORMAL' },
      { type: 'DROP_SHADOW', visible: false, color: black(1), offset: { x: 9, y: 9 }, radius: 9, blendMode: 'NORMAL' },
      { type: 'LAYER_BLUR', visible: true, radius: 4 },
      { type: 'BACKGROUND_BLUR', visible: true, radius: 20 },
    ] as unknown as Effect[];
    expect(compactEffects(effects)).toEqual({
      shadows: ['0 1 3 1 #0000004d', 'inset 0 2 6.33 0 #00000026'],
      blur: 4,
      backdropBlur: 20,
    });
  });
  it('returns {} without effects', () => {
    expect(compactEffects([])).toEqual({});
  });
});

describe('styleOverview', () => {
  const names = [
    'Corner/Small',
    'M3/sys/light/primary',
    'M3/sys/light/on-primary',
    'M3/sys/light-high-contrast/primary',
    'M3/sys/dark/primary',
    'M3/body/large',
  ];
  it('lists names when under the limit', () => {
    expect(styleOverview(names, undefined, 10)).toEqual({ names });
  });
  it('groups by the next path segment when over the limit', () => {
    expect(styleOverview(names, undefined, 3)).toEqual({ total: 6, groups: { Corner: 1, M3: 5 } });
    expect(styleOverview(names, 'M3/', 2)).toEqual({
      total: 5,
      groups: { 'M3/sys': 4, 'M3/body': 1 },
    });
  });
  it('respects segment boundaries in prefix', () => {
    expect(styleOverview(names, 'M3/sys/light', 10)).toEqual({
      names: ['M3/sys/light/primary', 'M3/sys/light/on-primary'],
    });
  });
});
