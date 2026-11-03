// The 6 cost-ordered tools on top of the async Figma Plugin API (dynamic-page).
// Not allowed here: findAll/findOne, synchronous getNodeById, loadAllPagesAsync.
import {
  EXPORT_TIMEOUT_MS,
  RPC_ERROR,
  SCREENSHOT_MAX_BYTES,
  STYLES_LIST_LIMIT,
  TOOLS,
  type ScreenshotSandboxResult,
  type StylesResult,
} from '../shared/protocol';
import {
  INSPECT_CHILD_LIMIT,
  NAME_MAX,
  TEXT_MAX,
  TEXT_NODE_LIMIT,
  TREE_CHILD_LIMIT,
  bbox,
  compactEffects,
  styleOverview,
  mergeRuns,
  minifySvg,
  pageLine,
  round2,
  transformInfo,
  type TransformInfo,
  nodeLine,
  textLine,
  toHex,
  topLevelNodes,
  treeLine,
  truncate,
} from './dsl';
import { RpcError, optBool, optInt, optNumber, optString, reqString, withTimeout } from './rpc';

type Params = Record<string, unknown> | undefined;
type Handler = (p: Params) => Promise<unknown>;

const OVERRIDE_FIELDS = ['characters', 'fills', 'strokes', 'visible'] as const;
const OVERRIDES_LIMIT = 50;
const INSPECT_TEXT_MAX = 2000;
/** Pixel cap checked before export, so huge nodes cannot freeze Figma. */
const SCREENSHOT_MAX_PIXELS = 32 * 1024 * 1024;
/** Every N nodes a traversal yields to the event loop so Figma stays responsive. */
const YIELD_EVERY = 2000;

const yieldToFigma = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------- node resolution ----------

async function resolveNode(nodeId: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new RpcError(RPC_ERROR.NODE_NOT_FOUND, 'NODE_NOT_FOUND', `Node ${nodeId} not found`, { nodeId });
  }
  if (node.type === 'DOCUMENT') {
    throw new RpcError(
      RPC_ERROR.UNSUPPORTED_NODE,
      'UNSUPPORTED_NODE',
      'DOCUMENT is not supported in dynamic-page mode; pass a page or node id',
    );
  }
  if (node.type === 'PAGE') await node.loadAsync();
  return node;
}

async function rootOrCurrentPage(p: Params): Promise<BaseNode> {
  const nodeId = optString(p, 'nodeId');
  if (nodeId) return resolveNode(nodeId);
  await figma.currentPage.loadAsync();
  return figma.currentPage;
}

// DOCUMENT is rejected in resolveNode, so children here are always SceneNodes.
const childrenOf = (n: BaseNode): readonly SceneNode[] =>
  'children' in n && n.type !== 'DOCUMENT' ? (n.children as readonly SceneNode[]) : [];

// ---------- 3.1 figma_get_selection ----------

export function selectionLines(): string[] {
  return topLevelNodes(figma.currentPage.selection).map(nodeLine);
}

const getSelection: Handler = async () => selectionLines();

// ---------- 3.2 figma_get_tree ----------

/** All pages of the file. The list is available in dynamic-page without loadAllPagesAsync (page children are not loaded). */
function pagesList(): string {
  const currentId = figma.currentPage.id;
  return figma.root.children.map((pg) => pageLine(pg, pg.id === currentId)).join('\n');
}

const getTree: Handler = async (p) => {
  if (optBool(p, 'pages', false)) return pagesList();
  const maxDepth = optInt(p, 'maxDepth', 2, 0, 10);
  const root = await rootOrCurrentPage(p);
  const lines: string[] = [];
  const walk = (n: BaseNode, depth: number): void => {
    const kids = childrenOf(n);
    lines.push(treeLine(n, depth, kids.length));
    if (depth >= maxDepth) return;
    const lim = Math.min(kids.length, TREE_CHILD_LIMIT);
    for (let i = 0; i < lim; i++) walk(kids[i], depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
};

// ---------- 3.3 figma_get_text ----------

/** Text is unavailable: reading characters throws, or it is empty despite visible non-zero geometry inside an INSTANCE. */
function readCharacters(n: TextNode): string | null {
  try {
    return n.characters;
  } catch {
    return null;
  }
}

const getText: Handler = async (p) => {
  const root = await rootOrCurrentPage(p);
  const lines: string[] = [];
  let truncated = 0;
  let skippedInstances = 0;
  let visited = 0;

  interface Frame {
    node: BaseNode;
    path: string[];
    inInstance: boolean;
  }
  // Explicit stack instead of recursion: real-world nesting depth is unpredictable. Document order is preserved.
  const stack: Frame[] = [{ node: root, path: [], inInstance: false }];
  while (stack.length > 0) {
    const { node, path, inInstance } = stack.pop() as Frame;
    if (++visited % YIELD_EVERY === 0) await yieldToFigma();

    const ownPath = node === root && node.type !== 'TEXT' ? path : path.concat(node.name);

    if (node.type === 'TEXT') {
      const chars = readCharacters(node);
      if (chars === null || chars === '') {
        const looksFilled = chars === null || (node.visible && node.width > 1 && node.height > 1);
        if (inInstance && looksFilled) skippedInstances++;
        continue;
      }
      if (lines.length < TEXT_NODE_LIMIT) lines.push(textLine(node.id, ownPath, chars));
      else truncated++;
      continue;
    }

    const kids = childrenOf(node);
    const childInInstance = inInstance || node.type === 'INSTANCE';
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i], path: ownPath, inInstance: childInInstance });
    }
  }

  if (truncated > 0) lines.push(`... truncated ${truncated} more`);
  lines.push(`skippedInstances: ${skippedInstances}`);
  return lines.join('\n');
};

// ---------- 3.4 figma_get_styles ----------

const getStyles: Handler = async (p): Promise<StylesResult> => {
  const prefix = optString(p, 'prefix');
  const names = new Set<string>();
  const [paint, text, effect, grid] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);
  for (const s of [...paint, ...text, ...effect, ...grid]) names.add(s.name);

  let variablesUnavailable = false;
  try {
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) names.add(v.name);
  } catch {
    variablesUnavailable = true;
  }

  const result: StylesResult = styleOverview(Array.from(names).sort(), prefix, STYLES_LIST_LIMIT);
  if (variablesUnavailable) result.variablesUnavailable = true;
  return result;
};

// ---------- 3.5 figma_inspect_node ----------

type PaintsOut = string[] | 'mixed';

/** SOLID -> hex, IMAGE -> "image"; gradients/video/patterns are dropped. */
function compactPaints(v: readonly Paint[] | PluginAPI['mixed']): PaintsOut {
  if (v === figma.mixed) return 'mixed';
  const out: string[] = [];
  for (const paint of v as readonly Paint[]) {
    if (paint.visible === false) continue;
    if (paint.type === 'SOLID') out.push(toHex(paint.color, paint.opacity === undefined ? 1 : paint.opacity));
    else if (paint.type === 'IMAGE') out.push('image');
  }
  return out;
}

class StyleNames {
  private readonly cache = new Map<string, string | null>();
  async name(styleId: string | PluginAPI['mixed'] | undefined): Promise<string | undefined> {
    if (!styleId || styleId === figma.mixed || typeof styleId !== 'string') return undefined;
    if (!this.cache.has(styleId)) {
      let n: string | null = null;
      try {
        const s = await figma.getStyleByIdAsync(styleId);
        n = s ? s.name : null;
      } catch {
        n = null;
      }
      this.cache.set(styleId, n);
    }
    return this.cache.get(styleId) || undefined;
  }
}

function lineHeightOut(lh: LineHeight | PluginAPI['mixed']): string {
  if (lh === figma.mixed) return 'mixed';
  const v = lh as LineHeight;
  if (v.unit === 'AUTO') return 'auto';
  return v.unit === 'PERCENT' ? `${Math.round(v.value)}%` : `${Math.round(v.value * 100) / 100}px`;
}

function letterSpacingOut(ls: LetterSpacing | PluginAPI['mixed']): string | undefined {
  if (ls === figma.mixed) return 'mixed';
  const v = ls as LetterSpacing;
  if (v.value === 0) return undefined;
  return v.unit === 'PERCENT' ? `${Math.round(v.value * 100) / 100}%` : `${Math.round(v.value * 100) / 100}px`;
}

async function componentInfo(inst: InstanceNode, withOverrides: boolean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let main: ComponentNode | null = null;
  try {
    main = await inst.getMainComponentAsync();
  } catch {
    main = null;
  }
  if (!main) {
    out.mainComponentUnavailable = true;
    if (withOverrides) out.overrides = {};
    return out;
  }
  out.mainComponentId = main.id;
  const parent = main.parent;
  out.componentName = parent && parent.type === 'COMPONENT_SET' ? `${parent.name}/${main.name}` : main.name;
  if (!withOverrides) return out;

  const overrides: Record<string, Record<string, unknown>> = {};
  let count = 0;
  let truncatedOverrides = 0;
  for (const o of inst.overrides) {
    const fields = o.overriddenFields.filter((f): f is (typeof OVERRIDE_FIELDS)[number] =>
      (OVERRIDE_FIELDS as readonly string[]).includes(f),
    );
    if (fields.length === 0) continue;
    if (count >= OVERRIDES_LIMIT) {
      truncatedOverrides++;
      continue;
    }
    const target = o.id === inst.id ? inst : await figma.getNodeByIdAsync(o.id);
    if (!target) continue;
    const entry: Record<string, unknown> = { name: truncate(target.name, NAME_MAX) };
    for (const f of fields) {
      if (f === 'characters' && target.type === 'TEXT') {
        const c = readCharacters(target);
        if (c !== null) entry.characters = truncate(c, TEXT_MAX);
      } else if (f === 'fills' && 'fills' in target) {
        entry.fills = compactPaints(target.fills);
      } else if (f === 'strokes' && 'strokes' in target) {
        entry.strokes = compactPaints(target.strokes);
      } else if (f === 'visible' && 'visible' in target) {
        entry.visible = target.visible;
      }
    }
    overrides[o.id === inst.id ? 'self' : o.id] = entry;
    count++;
  }
  out.overrides = overrides;
  if (truncatedOverrides > 0) out.truncatedOverrides = truncatedOverrides;
  return out;
}

async function level1(node: SceneNode, styles: StyleNames, out: Record<string, unknown>): Promise<void> {
  if ('opacity' in node && node.opacity < 1) out.opacity = Math.round(node.opacity * 100) / 100;
  if ('effects' in node) {
    Object.assign(out, compactEffects(node.effects));
    const effectStyle = await styles.name('effectStyleId' in node ? node.effectStyleId : undefined);
    if (effectStyle) out.effectStyleName = effectStyle;
  }

  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    const layout: Record<string, unknown> = {
      mode: node.layoutMode,
      gap: round2(node.itemSpacing),
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(Math.round),
      align: [node.primaryAxisAlignItems, node.counterAxisAlignItems],
    };
    if ('layoutWrap' in node && node.layoutWrap === 'WRAP') layout.wrap = true;
    if (node.clipsContent) layout.clip = true;
    out.layout = layout;
  }
  if ('layoutSizingHorizontal' in node) {
    out.sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
  }
  if ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE') out.absolute = true;

  if ('cornerRadius' in node) {
    if (node.cornerRadius === figma.mixed && 'topLeftRadius' in node) {
      out.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius].map(round2);
    } else if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      out.radius = round2(node.cornerRadius);
    }
  }

  if ('fills' in node) {
    const fills = compactPaints(node.fills);
    if (fills === 'mixed' || fills.length > 0) out.fills = fills;
    const styleName = await styles.name('fillStyleId' in node ? node.fillStyleId : undefined);
    if (styleName) out.fillStyleName = styleName;
  }
  if ('strokes' in node) {
    const strokes = compactPaints(node.strokes);
    if (strokes === 'mixed' || strokes.length > 0) {
      out.strokes = strokes;
      if ('strokeWeight' in node) out.strokeWeight = node.strokeWeight === figma.mixed ? 'mixed' : round2(node.strokeWeight);
      if ('strokeAlign' in node && node.strokeAlign !== 'INSIDE') out.strokeAlign = node.strokeAlign;
    }
    const styleName = await styles.name('strokeStyleId' in node ? node.strokeStyleId : undefined);
    if (styleName) out.strokeStyleName = styleName;
  }

  if (node.type === 'TEXT') {
    const text: Record<string, unknown> = {};
    const chars = readCharacters(node);
    if (chars !== null) text.characters = truncate(chars, INSPECT_TEXT_MAX);
    text.font = node.fontName === figma.mixed ? 'mixed' : `${node.fontName.family} ${node.fontName.style}`;
    text.size = node.fontSize === figma.mixed ? 'mixed' : round2(node.fontSize);
    text.lineHeight = lineHeightOut(node.lineHeight);
    const ls = letterSpacingOut(node.letterSpacing);
    if (ls) text.letterSpacing = ls;
    if (node.textAlignHorizontal !== 'LEFT') text.align = node.textAlignHorizontal;
    if (node.textAutoResize !== 'NONE') text.autoResize = node.textAutoResize;
    // Case and decoration change rendering without changing characters: without them the agent would render "cvx" instead of "CVX".
    if (node.textCase === figma.mixed) text.case = 'mixed';
    else if (node.textCase !== 'ORIGINAL') text.case = node.textCase;
    if (node.textDecoration === figma.mixed) text.decoration = 'mixed';
    else if (node.textDecoration !== 'NONE') text.decoration = node.textDecoration;
    const segments = mixedTextSegments(node);
    if (segments) {
      // A single real run: node-level "mixed" is spurious, so use the run values (or drop the default).
      if (!('segments' in segments)) {
        for (const k of ['font', 'size', 'case', 'decoration', 'letterSpacing']) if (text[k] === 'mixed') delete text[k];
      }
      Object.assign(text, segments);
    }
    const styleName = await styles.name(node.textStyleId);
    if (styleName) text.styleName = styleName;
    out.text = text;
  }
}

const SEGMENTS_LIMIT = 20;
const SEGMENT_TEXT_MAX = 40;

/**
 * If font/size/case/decoration/tracking vary across ranges ("mixed"), return a compact breakdown:
 * without it the agent cannot tell which part of the text uses which style.
 */
function mixedTextSegments(node: TextNode): Record<string, unknown> | undefined {
  const mixed =
    node.fontName === figma.mixed ||
    node.fontSize === figma.mixed ||
    node.textCase === figma.mixed ||
    node.textDecoration === figma.mixed ||
    node.letterSpacing === figma.mixed;
  if (!mixed) return undefined;
  const fields: ['fontName', 'fontSize', 'textCase', 'textDecoration', 'letterSpacing'] = [
    'fontName',
    'fontSize',
    'textCase',
    'textDecoration',
    'letterSpacing',
  ];
  let raw: Pick<StyledTextSegment, (typeof fields)[number] | 'characters' | 'start' | 'end'>[];
  try {
    raw = node.getStyledTextSegments(fields);
  } catch {
    return undefined;
  }
  const runs = mergeRuns(
    raw.map((s) => {
      const style: Record<string, unknown> = { font: `${s.fontName.family} ${s.fontName.style}`, size: s.fontSize };
      if (s.textCase !== 'ORIGINAL') style.case = s.textCase;
      if (s.textDecoration !== 'NONE') style.decoration = s.textDecoration;
      const ls = letterSpacingOut(s.letterSpacing);
      if (ls) style.letterSpacing = ls;
      return { text: s.characters, style };
    }),
  );
  // Figma reports mixed, but there is one run for the emitted properties: these are simply the node values.
  if (runs.length === 1) return runs[0].style;
  const segments = runs
    .slice(0, SEGMENTS_LIMIT)
    .map((r) => Object.assign({ text: truncate(r.text, SEGMENT_TEXT_MAX) }, r.style));
  const out: Record<string, unknown> = { segments };
  if (runs.length > SEGMENTS_LIMIT) out.truncatedSegments = runs.length - SEGMENTS_LIMIT;
  return out;
}

function geometryOf(n: SceneNode): TransformInfo | null {
  if (!('rotation' in n) || !('absoluteBoundingBox' in n)) return null;
  return transformInfo({
    x: n.x,
    y: n.y,
    rotation: n.rotation,
    relativeTransform: n.relativeTransform,
    absoluteTransform: n.absoluteTransform,
    absoluteBoundingBox: n.absoluteBoundingBox,
  });
}

/** `id|name|type|x,y,w,h[|hidden][|rot:N][|flipped]`, visible coordinates (rotation/flip applied). */
function childLine(n: SceneNode): string {
  const t = geometryOf(n);
  const [x, y, w, h] = (t && t.visualBBox) || bbox(n);
  let line = `${nodeLine(n)}|${x},${y},${w},${h}`;
  if (!n.visible) line += '|hidden';
  if (t && t.rotation) line += `|rot:${t.rotation}`;
  if (t && t.flipped) line += '|flipped';
  return line;
}

const inspectNode: Handler = async (p) => {
  const nodeId = reqString(p, 'nodeId');
  // level only controls depth; it is never echoed in the result.
  const level = optInt(p, 'level', 0, 0, 2);
  const wantSvg = optBool(p, 'svg', false);
  const node = await resolveNode(nodeId);

  const out: Record<string, unknown> = { id: node.id, name: truncate(node.name, NAME_MAX), type: node.type };
  if (node.type === 'PAGE') {
    out.childCount = node.children.length;
  } else {
    const scene = node as SceneNode;
    if ('x' in scene && 'width' in scene) out.bbox = bbox(scene as SceneNode & LayoutMixin);
    const t = geometryOf(scene);
    if (t) Object.assign(out, t);
    if (!scene.visible) out.visible = false;
    if ('children' in scene) out.childCount = scene.children.length;
    if (scene.type === 'INSTANCE') Object.assign(out, await componentInfo(scene, level >= 1));
    if (level >= 1) await level1(scene, new StyleNames(), out);
  }

  if (level >= 2) {
    const kids = childrenOf(node);
    out.children = kids.slice(0, INSPECT_CHILD_LIMIT).map(childLine);
    if (kids.length > INSPECT_CHILD_LIMIT) out.truncatedChildren = kids.length - INSPECT_CHILD_LIMIT;
  }
  if (wantSvg) Object.assign(out, await svgOf(node));
  return out;
};

const SVG_MAX_SIDE = 64;
const SVG_MAX_CHARS = 4000;

/** Opt-in SVG of a small node (icons): the vector shape/direction missing from the other data (docs/protocol.md). */
async function svgOf(node: BaseNode): Promise<{ svg: string } | { svgSkipped: string }> {
  if (node.type === 'PAGE' || !('exportAsync' in node) || !('width' in node)) {
    return { svgSkipped: `${node.type} cannot be exported` };
  }
  const scene = node as SceneNode;
  if (scene.width > SVG_MAX_SIDE || scene.height > SVG_MAX_SIDE) {
    return { svgSkipped: `larger than ${SVG_MAX_SIDE}px; use figma_get_screenshot` };
  }
  const raw = await withTimeout(
    scene.exportAsync({ format: 'SVG_STRING', svgIdAttribute: false }),
    EXPORT_TIMEOUT_MS,
    'exportAsync(SVG_STRING)',
  );
  const svg = minifySvg(raw);
  if (svg.length > SVG_MAX_CHARS) return { svgSkipped: `SVG is ${svg.length} chars (> ${SVG_MAX_CHARS})` };
  return { svg };
}

// ---------- 3.6 figma_get_screenshot ----------

const getScreenshot: Handler = async (p): Promise<ScreenshotSandboxResult> => {
  const nodeId = reqString(p, 'nodeId');
  const scale = optNumber(p, 'scale', 1, 0.01, 4);
  const node = await resolveNode(nodeId);
  if (!('exportAsync' in node) || !('width' in node)) {
    throw new RpcError(RPC_ERROR.UNSUPPORTED_NODE, 'UNSUPPORTED_NODE', `${node.type} cannot be exported`);
  }
  const width = Math.max(1, Math.ceil(node.width * scale));
  const height = Math.max(1, Math.ceil(node.height * scale));
  const tooLarge = (size: number | undefined): RpcError => {
    const ratio = size ? Math.sqrt(SCREENSHOT_MAX_BYTES / size) : Math.sqrt(SCREENSHOT_MAX_PIXELS / (width * height));
    const suggestedScale = Math.max(0.01, Math.floor(scale * ratio * 0.9 * 100) / 100);
    return new RpcError(
      RPC_ERROR.SCREENSHOT_TOO_LARGE,
      'SCREENSHOT_TOO_LARGE',
      size
        ? `PNG exceeds 5 MB limit; retry with scale <= ${suggestedScale}`
        : `Image ${width}x${height} exceeds the ${SCREENSHOT_MAX_PIXELS / (1024 * 1024)} MP pre-export limit; retry with scale <= ${suggestedScale}`,
      { size, width, height, limit: SCREENSHOT_MAX_BYTES, suggestedScale },
    );
  };
  if (width * height > SCREENSHOT_MAX_PIXELS) throw tooLarge(undefined);

  const bytes = await withTimeout(
    (node as SceneNode).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }),
    EXPORT_TIMEOUT_MS,
    'exportAsync',
  );
  if (bytes.length > SCREENSHOT_MAX_BYTES) throw tooLarge(bytes.length);
  // The sandbox postMessage cannot clone a Uint8Array -> plain object with a number array.
  return { mimeType: 'image/png', width, height, size: bytes.length, bytes: Array.from(bytes) };
};

export const HANDLERS: Record<string, Handler> = {
  [TOOLS.GET_SELECTION]: getSelection,
  [TOOLS.GET_TREE]: getTree,
  [TOOLS.GET_TEXT]: getText,
  [TOOLS.GET_STYLES]: getStyles,
  [TOOLS.INSPECT_NODE]: inspectNode,
  [TOOLS.GET_SCREENSHOT]: getScreenshot,
};
