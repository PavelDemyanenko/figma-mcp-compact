// Pure formatting functions for the compact DSL. No Figma API dependencies, covered by unit tests.

export const NAME_MAX = 80;
export const TEXT_MAX = 200;
export const TREE_CHILD_LIMIT = 50;
export const TEXT_NODE_LIMIT = 500;
export const INSPECT_CHILD_LIMIT = 100;

/** Truncate to max characters (by code point, so surrogate pairs are never split), adding `…`. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
}

/**
 * DSL field escaping: `\` -> `\\`, `|` -> `\|`, line breaks -> `\n`.
 * So a DSL line is always single-line and splits unambiguously on unescaped `|`.
 */
export function escapeField(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n');
}

export const field = (s: string, max: number): string => escapeField(truncate(s, max));

/** `<id>|<name>|<type>` */
export function nodeLine(n: { id: string; name: string; type: string }): string {
  return `${n.id}|${field(n.name, NAME_MAX)}|${n.type}`;
}

/** `<indent><id>|<name>|<type>|<childCount>[|truncated:N]` */
export function treeLine(n: { id: string; name: string; type: string }, depth: number, childCount: number): string {
  const indent = '  '.repeat(depth);
  const tail = childCount > TREE_CHILD_LIMIT ? `|truncated:${childCount - TREE_CHILD_LIMIT}` : '';
  return `${indent}${nodeLine(n)}|${childCount}${tail}`;
}

/** `<id>|<path>|<text>` */
export function textLine(id: string, path: string[], text: string): string {
  return `${id}|${path.map((p) => field(p, NAME_MAX)).join('/')}|${field(text, TEXT_MAX)}`;
}

const hex2 = (v: number): string => {
  const n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return (n < 16 ? '0' : '') + n.toString(16);
};

/** RGB(0..1) -> `#rrggbb`; with opacity < 1 -> `#rrggbbaa`. */
export function toHex(c: { r: number; g: number; b: number }, opacity = 1): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return opacity < 1 ? base + hex2(opacity) : base;
}

/** Fractional values from Figma (71.82662200927734) -> 2 decimals: precise enough, fewer tokens. */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

export type BBox = [number, number, number, number];
export function bbox(n: { x: number; y: number; width: number; height: number }): BBox {
  return [Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height)];
}

/** Selected nodes whose ancestor is not in the same selection (top-level only). */
export function topLevelNodes<T extends { id: string; parent: { id: string; parent: unknown } | null }>(
  nodes: readonly T[],
): T[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.filter((n) => {
    let p = n.parent as { id: string; parent: unknown } | null;
    while (p) {
      if (ids.has(p.id)) return false;
      p = p.parent as { id: string; parent: unknown } | null;
    }
    return true;
  });
}

/** A text run with the emitted style properties. */
export interface TextRun {
  text: string;
  style: Record<string, unknown>;
}

/**
 * Merges adjacent runs with the same emitted style: Figma also splits text by properties we do not
 * emit, so without merging the agent would get "NORMA" + "L" in the same font.
 */
export function mergeRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  let lastKey = '';
  for (const r of runs) {
    const key = JSON.stringify(r.style);
    const last = out[out.length - 1];
    if (last && key === lastKey) {
      last.text += r.text;
    } else {
      out.push({ text: r.text, style: r.style });
      lastKey = key;
    }
  }
  return out;
}

/** Figma affine matrix [[a, c, tx], [b, d, ty]]. */
export type Mat2x3 = readonly [readonly [number, number, number], readonly [number, number, number]];

export interface Geometry {
  x: number;
  y: number;
  rotation: number;
  relativeTransform: Mat2x3;
  absoluteTransform: Mat2x3;
  absoluteBoundingBox: { x: number; y: number; width: number; height: number } | null;
}

export interface TransformInfo {
  rotation?: number;
  flipped?: true;
  /** Visible bounds in the same coordinates as bbox (x/y/width/height describe the box BEFORE rotation). */
  visualBBox?: BBox;
}

/**
 * Node rotation/flip. null means no transform, and bbox equals the visible bounds.
 * A flip is a negative matrix determinant (Figma stores flips in the matrix, not in rotation).
 */
export function transformInfo(g: Geometry): TransformInfo | null {
  const [[a, c], [b, d]] = [g.relativeTransform[0], g.relativeTransform[1]];
  const flipped = a * d - b * c < 0;
  const rotation = ((Math.round(g.rotation) % 360) + 360) % 360;
  if (!flipped && rotation === 0) return null;
  const out: TransformInfo = {};
  if (rotation !== 0) out.rotation = rotation;
  if (flipped) out.flipped = true;
  const abb = g.absoluteBoundingBox;
  if (abb) {
    // The offset of the visible corner from the anchor (x, y) is the same in absolute and parent coordinates.
    out.visualBBox = [
      Math.round(g.x + (abb.x - g.absoluteTransform[0][2])),
      Math.round(g.y + (abb.y - g.absoluteTransform[1][2])),
      Math.round(abb.width),
      Math.round(abb.height),
    ];
  }
  return out;
}

/** Page list line: `<id>|<name>|PAGE[|current]` (no childCount: the page would have to be loaded). */
export function pageLine(p: { id: string; name: string }, current: boolean): string {
  return `${p.id}|${field(p.name, NAME_MAX)}|PAGE${current ? '|current' : ''}`;
}

/**
 * Compact SVG for inline markup: no line breaks or indentation, no xmlns
 * (not needed for inline SVG in HTML/JSX), numbers rounded to 2 decimals.
 */
export function minifySvg(svg: string): string {
  return svg
    .replace(/\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')
    .replace(/(\d+\.\d{3,})/g, (m) => String(round2(Number(m))))
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Shadows in CSS box-shadow syntax (`[inset ]x y blur spread #rrggbbaa`) and blurs (docs/protocol.md).
 * Other effects (noise, texture, glass) are not emitted.
 */
export function compactEffects(effects: readonly Effect[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const shadows: string[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      shadows.push(
        `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${round2(e.offset.x)} ${round2(e.offset.y)} ${round2(e.radius)} ` +
          `${round2(e.spread || 0)} ${toHex(e.color, e.color.a)}`,
      );
    } else if (e.type === 'LAYER_BLUR') {
      out.blur = round2(e.radius);
    } else if (e.type === 'BACKGROUND_BLUR') {
      out.backdropBlur = round2(e.radius);
    }
  }
  if (shadows.length > 0) out.shadows = shadows;
  return out;
}

/**
 * Style name overview (docs/protocol.md). Names are filtered by `prefix` on segment boundaries ("M3/sys/light"
 * does not match "M3/sys/light-high-contrast/…"). Up to `limit`: a list, otherwise groups by the next segment.
 */
export function styleOverview(
  allNames: readonly string[],
  prefix: string | undefined,
  limit: number,
): { names: string[] } | { total: number; groups: Record<string, number> } {
  const p = prefix ? prefix.replace(/\/+$/, '') : '';
  const names = p ? allNames.filter((n) => n === p || n.startsWith(p + '/')) : allNames.slice();
  if (names.length <= limit) return { names };
  const groups: Record<string, number> = {};
  for (const n of names) {
    const rest = p ? n.slice(p.length + 1) : n;
    const seg = rest.split('/')[0];
    const key = p ? `${p}/${seg}` : seg;
    groups[key] = (groups[key] || 0) + 1;
  }
  return { total: names.length, groups };
}
