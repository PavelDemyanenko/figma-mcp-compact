// ui.html: bridge WebSocket client (ws://localhost:3055), exponential backoff 1s -> 30s,
// postMessage routing by the type discriminator ("response" | "notify"), diagnostic UI.
import { STRINGS, resolveLang, type LangPref, type StaticKey, type Strings } from './i18n';
import { formatReport, formatRow, type BenchPart, type BenchRow } from './shared/bench';
import {
  BRIDGE_URL,
  DEFAULT_PREFS,
  LOCAL_ID_PREFIX,
  LOCAL_NOTIFY,
  LOCAL_NOTIFY_PREFIX,
  NOTIFY,
  RPC_ERROR,
  TOOLS,
  type BenchBaselineParams,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type SandboxToUi,
  type ScreenshotSandboxResult,
  type ScreenshotWireResult,
  type UiPrefs,
  type UiToSandbox,
} from './shared/protocol';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** After this many failures in a row the status turns red, but background retries every 30s continue. */
const RETRIES_BEFORE_RED = 5;
const LOG_LIMIT = 200;
const SIZE_EXPANDED = { width: 300, height: 440 };
const SIZE_COLLAPSED = { width: 300, height: 40 };
const PORT_LABEL = ':' + new URL(BRIDGE_URL.replace(/^ws/, 'http')).port;

type Status = 'disconnected' | 'connecting' | 'retrying' | 'connected';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = {
  dot: $('dot'),
  title: $('title'),
  statusText: $('status-text'),
  statusSub: $('status-sub'),
  connect: $<HTMLButtonElement>('btn-connect'),
  settingsBtn: $<HTMLButtonElement>('btn-settings'),
  settings: $('settings'),
  url: $<HTMLInputElement>('url'),
  autoConnect: $<HTMLInputElement>('auto-connect'),
  collapse: $<HTMLButtonElement>('btn-collapse'),
  selection: $('selection'),
  copy: $<HTMLButtonElement>('btn-copy'),
  bench: $<HTMLButtonElement>('btn-bench'),
  lang: $<HTMLSelectElement>('lang'),
  clear: $<HTMLButtonElement>('btn-clear'),
  log: $<HTMLOListElement>('log'),
};

let prefs: UiPrefs = { ...DEFAULT_PREFS };
/** Current dictionary (docs/architecture.md, Localization). Until prefs load, follows the system language. */
let t: Strings = STRINGS[resolveLang('auto', navigator.language)];
let lastSelection: string[] = [];

/** Static markup texts: data-i18n (text), data-i18n-title, data-i18n-aria. */
function applyStaticTexts(): void {
  document.documentElement.lang = t === STRINGS.ru ? 'ru' : 'en';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((n) => {
    n.textContent = t[n.dataset.i18n as StaticKey];
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((n) => {
    n.title = t[n.dataset.i18nTitle as StaticKey];
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((n) => {
    n.setAttribute('aria-label', t[n.dataset.i18nAria as StaticKey]);
  });
  el.log.dataset.empty = t.logEmpty;
}

function applyLang(): void {
  t = STRINGS[resolveLang(prefs.lang as LangPref, navigator.language)];
  el.lang.value = prefs.lang;
  applyStaticTexts();
  applyCollapsed();
  renderSelection(lastSelection);
}
let ws: WebSocket | null = null;
let status: Status = 'disconnected';
let attempt = 0;
let manualDisconnect = false;
let retryTimer: number | undefined;
let countdownTimer: number | undefined;
let retryAt = 0;

/** Bridge requests in flight: for the log and timing. */
const inflight = new Map<string, { method: string; started: number }>();
/** Local UI requests (the "Copy slice" button): their responses are not sent to the bridge. */
const localPending = new Map<string, (r: JsonRpcResponse) => void>();
let localSeq = 0;
const localNonce = Math.random().toString(36).slice(2, 8);

const toSandbox = (msg: UiToSandbox): void => parent.postMessage({ pluginMessage: msg }, '*');

// ---------- log ----------

const hhmmss = (): string => new Date().toTimeString().slice(0, 8);

function log(text: string, kind: '' | 'err' | 'ok' = ''): void {
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `[${hhmmss()}] `;
  const body = document.createElement('span');
  if (kind) body.className = kind;
  body.textContent = text;
  li.append(t, body);
  const stick = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 4;
  el.log.append(li);
  while (el.log.childElementCount > LOG_LIMIT) el.log.firstElementChild?.remove();
  if (stick) el.log.scrollTop = el.log.scrollHeight;
}

// ---------- status ----------

function render(): void {
  el.dot.dataset.s = status === 'retrying' && attempt > RETRIES_BEFORE_RED ? 'disconnected' : status;
  const wait = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  let text: string;
  let sub = BRIDGE_URL;
  switch (status) {
    case 'connected':
      text = t.connected(PORT_LABEL);
      break;
    case 'connecting':
      text = t.connecting;
      break;
    case 'retrying':
      text =
        attempt > RETRIES_BEFORE_RED
          ? t.notFound(wait)
          : t.retrying(wait, attempt, RETRIES_BEFORE_RED);
      sub = `${BRIDGE_URL} · ${t.startBridge}`;
      break;
    default:
      text = t.disconnected;
  }
  el.statusText.textContent = text;
  el.statusSub.textContent = sub;
  el.connect.textContent = status === 'connected' ? t.btnDisconnect : status === 'disconnected' ? t.btnConnect : t.btnReconnect;
  el.connect.classList.toggle('primary', status !== 'connected');
  el.title.textContent = prefs.collapsed ? `MCP Compact · ${text}` : 'Figma MCP Compact';
}

function setStatus(s: Status): void {
  status = s;
  if (countdownTimer !== undefined) clearInterval(countdownTimer);
  countdownTimer = s === 'retrying' ? window.setInterval(render, 1000) : undefined;
  render();
}

// ---------- WebSocket ----------

function clearRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function connect(): void {
  clearRetry();
  manualDisconnect = false;
  attempt = 0;
  open();
}

function disconnect(): void {
  manualDisconnect = true;
  clearRetry();
  const sock = ws;
  ws = null;
  sock?.close(1000, 'manual disconnect');
  inflight.clear();
  setStatus('disconnected');
  log(t.manualDisconnect);
}

function open(): void {
  setStatus(attempt === 0 ? 'connecting' : 'retrying');
  let sock: WebSocket;
  try {
    sock = new WebSocket(BRIDGE_URL);
  } catch (e) {
    log(`WebSocket: ${(e as Error).message}`, 'err');
    scheduleRetry();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    attempt = 0;
    setStatus('connected');
    log(t.connectedTo(BRIDGE_URL), 'ok');
    toSandbox({ type: 'ws_connected' });
  };
  sock.onmessage = (ev: MessageEvent) => {
    if (ws === sock) onBridgeMessage(ev.data);
  };
  sock.onclose = (ev: CloseEvent) => {
    if (ws !== sock) return; // stale socket (manual disconnect / reconnect)
    ws = null;
    inflight.clear();
    if (status === 'connected') log(t.closed(ev.code), 'err');
    if (!manualDisconnect) scheduleRetry();
  };
  // onerror is always followed by onclose, which handles reconnecting.
  sock.onerror = () => undefined;
}

function scheduleRetry(): void {
  clearRetry();
  attempt++;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const delay = Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + Math.random() * 0.4))); // ±20% jitter
  retryAt = Date.now() + delay;
  retryTimer = window.setTimeout(open, delay);
  setStatus('retrying');
  if (attempt === RETRIES_BEFORE_RED + 1) log(t.unreachable, 'err');
}

function sendToBridge(payload: JsonRpcResponse | JsonRpcNotification): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    log(t.sendFailed((e as Error).message), 'err');
    return false;
  }
}

const rpcError = (id: null, code: number, reason: 'PARSE_ERROR' | 'INVALID_REQUEST', message: string): JsonRpcFailure => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, data: { reason } },
});

function onBridgeMessage(data: unknown): void {
  if (typeof data !== 'string') {
    sendToBridge(rpcError(null, RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', 'Binary frames are not supported'));
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    sendToBridge(rpcError(null, RPC_ERROR.PARSE_ERROR, 'PARSE_ERROR', 'Invalid JSON'));
    log(t.invalidJson, 'err');
    return;
  }
  if (Array.isArray(msg)) {
    sendToBridge(rpcError(null, RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', 'Batch requests are not supported'));
    return;
  }
  const req = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const method = typeof req.method === 'string' ? req.method : '?';
  if (typeof req.id === 'string' || typeof req.id === 'number') {
    inflight.set(String(req.id), { method, started: performance.now() });
  }
  log(`→ ${method}${describeParams(req.params)}`);
  // Envelope validation (id, jsonrpc, params) happens in one place: code.ts.
  toSandbox({ type: 'rpc', payload: msg });
}

function describeParams(p: Record<string, unknown> | undefined): string {
  if (!p || typeof p !== 'object') return '';
  const parts: string[] = [];
  if (typeof p.nodeId === 'string') parts.push(p.nodeId);
  if (typeof p.level === 'number') parts.push(`L${p.level}`);
  if (typeof p.maxDepth === 'number') parts.push(`depth ${p.maxDepth}`);
  if (typeof p.scale === 'number') parts.push(`×${p.scale}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// ---------- sandbox responses and notifications ----------

function isScreenshot(v: unknown): v is ScreenshotSandboxResult {
  return !!v && typeof v === 'object' && Array.isArray((v as ScreenshotSandboxResult).bytes);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** number[] -> Uint8Array -> base64 for JSON-RPC over WebSocket (docs/protocol.md). */
function toWire(payload: JsonRpcResponse): JsonRpcResponse {
  if (!('result' in payload) || !isScreenshot(payload.result)) return payload;
  const { bytes, ...meta } = payload.result;
  const result: ScreenshotWireResult = { ...meta, data: toBase64(new Uint8Array(bytes)) };
  return { ...payload, result };
}

function summarize(method: string, r: JsonRpcResponse): string {
  if ('error' in r) return `ERR ${r.error.code} ${r.error.data?.reason ?? ''} ${r.error.message}`.trim();
  const res = r.result as unknown;
  if (typeof res === 'string') return `${res ? res.split('\n').length : 0} lines`;
  if (Array.isArray(res)) return `${res.length} nodes`;
  if (method === TOOLS.GET_SCREENSHOT && res && typeof res === 'object') {
    const s = res as ScreenshotWireResult;
    return `PNG ${s.width}×${s.height}, ${Math.round(s.size / 1024)} KB`;
  }
  if (method === TOOLS.GET_STYLES && res && typeof res === 'object') {
    const s = res as { names?: string[]; total?: number; groups?: Record<string, number>; variablesUnavailable?: boolean };
    const what = s.names ? `${s.names.length} names` : `${s.total ?? 0} names in ${Object.keys(s.groups ?? {}).length} groups`;
    return `${what}${s.variablesUnavailable ? ' (variables unavailable)' : ''}`;
  }
  if (res && typeof res === 'object' && 'type' in res) return String((res as { type: unknown }).type);
  return 'ok';
}

function onResponse(payload: JsonRpcResponse): void {
  const key = payload.id === null ? null : String(payload.id);
  if (key !== null && localPending.has(key)) {
    const resolve = localPending.get(key)!;
    localPending.delete(key);
    resolve(payload);
    return;
  }
  const meta = key !== null ? inflight.get(key) : undefined;
  if (key !== null) inflight.delete(key);
  const wire = toWire(payload);
  const ms = meta ? Math.round(performance.now() - meta.started) : 0;
  const sent = sendToBridge(wire);
  const isErr = 'error' in wire;
  log(`← ${meta?.method ?? 'invalid'} ${ms}ms · ${summarize(meta?.method ?? '', wire)}${sent ? '' : t.notDelivered}`, isErr ? 'err' : '');
}

function renderSelection(lines: string[]): void {
  lastSelection = lines;
  if (lines.length === 0) {
    el.selection.textContent = t.nothingSelected;
    el.selection.title = '';
    return;
  }
  const [id, name, type] = lines[0].split(/(?<!\\)\|/);
  const first = `${type ?? ''} "${(name ?? '').replace(/\\(.)/g, '$1')}" (${id})`;
  el.selection.textContent = lines.length === 1 ? t.selectedOne(first) : t.selectedMany(lines.length, first);
  el.selection.title = lines.join('\n');
}

function onNotify(n: JsonRpcNotification): void {
  if (n.method.startsWith(LOCAL_NOTIFY_PREFIX)) {
    if (n.method === LOCAL_NOTIFY.PREFS) applyPrefs(n.params as unknown as UiPrefs);
    if (n.method === LOCAL_NOTIFY.BENCH_BASELINE) {
      const p = n.params as unknown as BenchBaselineParams;
      benchPending.get(p.requestId)?.(p);
      benchPending.delete(p.requestId);
    }
    return;
  }
  if (n.method === NOTIFY.SELECTION_CHANGED && Array.isArray(n.params)) renderSelection(n.params as string[]);
  if (n.method === NOTIFY.STYLES_INVALIDATED) log(t.stylesInvalidated);
  sendToBridge(n);
}

window.onmessage = (ev: MessageEvent) => {
  const msg = (ev.data as { pluginMessage?: SandboxToUi } | null)?.pluginMessage;
  if (!msg) return;
  if (msg.type === 'response') onResponse(msg.payload);
  else if (msg.type === 'notify') onNotify(msg.payload);
};

// ---------- settings and collapsing ----------

let prefsLoaded = false;
function applyPrefs(p: UiPrefs): void {
  prefs = { ...DEFAULT_PREFS, ...p };
  el.autoConnect.checked = prefs.autoConnect;
  applyLang();
  if (!prefsLoaded) {
    prefsLoaded = true;
    if (prefs.autoConnect) connect();
    else render();
  }
}

function savePrefs(): void {
  toSandbox({ type: 'prefs_set', prefs });
}

function applyCollapsed(): void {
  document.body.classList.toggle('collapsed', prefs.collapsed);
  el.collapse.textContent = prefs.collapsed ? '▸' : '▾';
  el.collapse.title = el.collapse.ariaLabel = prefs.collapsed ? t.expand : t.collapse;
  toSandbox({ type: 'resize', ...(prefs.collapsed ? SIZE_COLLAPSED : SIZE_EXPANDED) });
  render();
}

// ---------- "Copy slice for AI" ----------

function localRpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = `${LOCAL_ID_PREFIX}${localNonce}:${++localSeq}`;
  return new Promise((resolve) => {
    localPending.set(id, resolve);
    toSandbox({ type: 'rpc', payload: { jsonrpc: '2.0', id, method, params } });
  });
}

const resultOf = <T>(r: JsonRpcResponse): T => {
  if ('error' in r) throw new Error(r.error.message);
  return r.result as T;
};

async function copySlice(): Promise<void> {
  el.copy.disabled = true;
  try {
    const selection = resultOf<string[]>(await localRpc(TOOLS.GET_SELECTION));
    const parts: string[] = [];
    if (selection.length === 0) {
      parts.push('# figma_get_tree (current page, depth 1)', resultOf<string>(await localRpc(TOOLS.GET_TREE, { maxDepth: 1 })));
    } else {
      parts.push('# figma_get_selection', selection.join('\n'));
      for (const line of selection.slice(0, 5)) {
        const nodeId = line.split('|')[0];
        parts.push(`# figma_get_tree ${nodeId}`, resultOf<string>(await localRpc(TOOLS.GET_TREE, { nodeId, maxDepth: 2 })));
      }
      if (selection.length > 5) parts.push(t.moreNodes(selection.length - 5));
    }
    const text = parts.join('\n');
    copyText(text);
    log(t.sliceCopied(text.split('\n').length, Math.ceil(text.length / 4)), 'ok');
  } catch (e) {
    log(t.sliceFailed((e as Error).message), 'err');
  } finally {
    el.copy.disabled = false;
  }
}

// ---------- dev token benchmark (docs/benchmark.md) ----------

const BENCH_MAX_NODES = 5;
const benchPending = new Map<string, (p: BenchBaselineParams) => void>();

function baseline(nodeIds: string[]): Promise<BenchBaselineParams> {
  const requestId = `${LOCAL_ID_PREFIX}bench:${localNonce}:${++localSeq}`;
  return new Promise((resolve) => {
    benchPending.set(requestId, resolve);
    toSandbox({ type: 'bench_baseline', requestId, nodeIds });
  });
}

/** Response length exactly as the bridge hands it to the agent (DSL string / minified JSON). */
async function measure(label: string, method: string, params: Record<string, unknown>): Promise<BenchPart> {
  const r = await localRpc(method, params);
  if ('error' in r) return { label, chars: 0, error: r.error.message };
  const res = r.result;
  return { label, chars: typeof res === 'string' ? res.length : JSON.stringify(res).length };
}

async function runBench(): Promise<void> {
  el.bench.disabled = true;
  try {
    const selection = resultOf<string[]>(await localRpc(TOOLS.GET_SELECTION));
    if (selection.length === 0) {
      log(t.benchSelect, 'err');
      return;
    }
    const nodeIds = selection.slice(0, BENCH_MAX_NODES).map((l) => l.split('|')[0]);
    log(t.benchStart(nodeIds.length));
    const base = await baseline(nodeIds);
    const rows: BenchRow[] = [];
    for (const b of base.items) {
      // Agent scenario: the whole tree (up to 10 levels), all texts, detailed inspection of the root.
      const parts = [
        await measure('tree', TOOLS.GET_TREE, { nodeId: b.nodeId, maxDepth: 10 }),
        await measure('text', TOOLS.GET_TEXT, { nodeId: b.nodeId }),
        await measure('inspect', TOOLS.INSPECT_NODE, { nodeId: b.nodeId, level: 2 }),
      ];
      const row: BenchRow = {
        nodeId: b.nodeId,
        name: b.name,
        type: b.type,
        baselineChars: b.chars,
        baselineError: b.error,
        parts,
      };
      rows.push(row);
      log(formatRow(row, t), b.error ? 'err' : 'ok');
    }
    if (selection.length > BENCH_MAX_NODES) log(t.benchFirst(BENCH_MAX_NODES, selection.length));
    try {
      copyText(formatReport(rows, t));
      log(t.benchCopied, 'ok');
    } catch {
      log(t.benchNotCopied, 'err');
    }
  } catch (e) {
    log(t.benchFailed((e as Error).message), 'err');
  } finally {
    el.bench.disabled = false;
  }
}

/** navigator.clipboard is blocked by policy in the Figma iframe, so execCommand is used. */
function copyText(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error(t.clipboardUnavailable);
}

// ---------- handlers ----------

el.url.value = BRIDGE_URL;
el.connect.onclick = () => (status === 'connected' ? disconnect() : connect());
el.settingsBtn.onclick = () => {
  const open = el.settings.hidden;
  el.settings.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', String(open));
  if (open && prefs.collapsed) {
    prefs.collapsed = false;
    applyCollapsed();
    savePrefs();
  }
};
el.autoConnect.onchange = () => {
  prefs.autoConnect = el.autoConnect.checked;
  savePrefs();
};
el.collapse.onclick = () => {
  prefs.collapsed = !prefs.collapsed;
  applyCollapsed();
  savePrefs();
};
el.copy.onclick = () => void copySlice();
el.bench.onclick = () => void runBench();
el.lang.onchange = () => {
  prefs.lang = el.lang.value as LangPref;
  applyLang();
  savePrefs();
};
el.clear.onclick = () => el.log.replaceChildren();

applyStaticTexts();
renderSelection([]);
render();
toSandbox({ type: 'prefs_get' });
