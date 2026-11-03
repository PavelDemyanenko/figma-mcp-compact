// Figma sandbox (QuickJS). No WebSocket/DOM here: all networking goes through ui.html and postMessage.
// Every RPC request is guaranteed a response (result or error) so the MCP host never hangs.
import {
  DEFAULT_PREFS,
  LOCAL_NOTIFY,
  NOTIFY,
  RPC_ERROR,
  type HelloParams,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type SandboxToUi,
  type UiPrefs,
  type UiToSandbox,
} from './shared/protocol';
import { RpcError, failure, isFailure, validateRequest } from './sandbox/rpc';
import { restJsonBaseline } from './sandbox/bench';
import { HANDLERS, selectionLines } from './sandbox/tools';

const PLUGIN_VERSION = '0.1.1';
const PREFS_KEY = 'mcp-bridge.prefs';
const SELECTION_DEBOUNCE_MS = 120;
/**
 * The Plugin API does not expose the file version. fileVersion is a plugin session id, so after a
 * plugin restart the bridge always starts with a clean cache (docs/architecture.md).
 */
const FILE_VERSION = `session-${Date.now().toString(36)}`;

figma.showUI(__html__, { width: 300, height: 440, themeColors: true, title: 'Figma MCP Compact' });

const post = (msg: SandboxToUi): void => figma.ui.postMessage(msg);
const notify = (method: string, params?: JsonRpcNotification['params']): void =>
  post({ type: 'notify', payload: { jsonrpc: '2.0', method, params } });

async function handleRpc(raw: unknown): Promise<JsonRpcResponse> {
  const req = validateRequest(raw);
  if (isFailure(req)) return req;
  try {
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, req.method) ? HANDLERS[req.method] : undefined;
    if (!handler) {
      throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, 'METHOD_NOT_FOUND', `Unknown method: ${req.method}`);
    }
    const result = await handler(req.params);
    return { jsonrpc: '2.0', id: req.id, result };
  } catch (e) {
    return failure(req.id, e);
  }
}

/** figma.fileKey exists only for private org plugins (enablePrivatePluginApi); Community builds fall back to the file name. */
function fileKey(): string {
  return figma.fileKey || `local:${figma.root.name}`;
}

async function sendHello(): Promise<void> {
  try {
    await figma.currentPage.loadAsync();
  } catch {
    // the current page is almost always loaded already; sending hello matters more
  }
  const params: HelloParams = {
    fileKey: fileKey(),
    fileVersion: FILE_VERSION,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length,
    pluginVersion: PLUGIN_VERSION,
  };
  notify(NOTIFY.HELLO, params as unknown as Record<string, unknown>);
  notify(NOTIFY.SELECTION_CHANGED, selectionLines());
}

async function loadPrefs(): Promise<UiPrefs> {
  try {
    const stored = (await figma.clientStorage.getAsync(PREFS_KEY)) as Partial<UiPrefs> | undefined;
    return Object.assign({}, DEFAULT_PREFS, stored || {});
  } catch {
    return DEFAULT_PREFS;
  }
}

// ---------- messages from the UI ----------

figma.ui.onmessage = (msg: UiToSandbox) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'rpc':
      // handleRpc catches all errors itself; the outer catch guards against postMessage/serialization failures.
      handleRpc(msg.payload)
        .catch((e: unknown) => failure(extractId(msg.payload), e))
        .then((payload) => post({ type: 'response', payload }));
      return;
    case 'ws_connected':
      void sendHello();
      return;
    case 'prefs_get':
      // First UI message after the iframe loads: send prefs and the initial selection for the live panel
      // (the UI does not forward selection_changed to the bridge until the WebSocket is connected).
      void loadPrefs().then((prefs) => {
        notify(LOCAL_NOTIFY.PREFS, prefs as unknown as Record<string, unknown>);
        notify(NOTIFY.SELECTION_CHANGED, selectionLines());
      });
      return;
    case 'prefs_set':
      void figma.clientStorage.setAsync(PREFS_KEY, msg.prefs).catch(() => undefined);
      return;
    case 'bench_baseline': {
      const { requestId } = msg;
      const nodeIds = Array.isArray(msg.nodeIds) ? msg.nodeIds.filter((id) => typeof id === 'string').slice(0, 5) : [];
      void restJsonBaseline(nodeIds).then((items) =>
        notify(LOCAL_NOTIFY.BENCH_BASELINE, { requestId, items } as unknown as Record<string, unknown>),
      );
      return;
    }
    case 'resize':
      figma.ui.resize(clamp(msg.width, 240, 480), clamp(msg.height, 36, 720));
      return;
  }
};

function extractId(raw: unknown): string | number | null {
  if (raw && typeof raw === 'object') {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(v) ? Math.round(v) : min));

// ---------- background events (no loadAllPagesAsync) ----------

let selectionTimer: ReturnType<typeof setTimeout> | undefined;
figma.on('selectionchange', () => {
  if (selectionTimer !== undefined) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = undefined;
    notify(NOTIFY.SELECTION_CHANGED, selectionLines());
  }, SELECTION_DEBOUNCE_MS);
});

figma.on('stylechange', () => {
  notify(NOTIFY.STYLES_INVALIDATED, { timestamp: Date.now() });
});

// A page switch changes pageId in the bridge state -> send hello again.
figma.on('currentpagechange', () => {
  void sendHello();
});
