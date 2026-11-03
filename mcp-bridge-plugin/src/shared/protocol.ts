// Shared plugin contract: JSON-RPC 2.0 (bridge <-> ui.html <-> code.ts) and postMessage envelopes.
// Any change to this file is a protocol change: update docs/protocol.md together with it.

// localhost, not 127.0.0.1: Figma rejects IP addresses in the manifest networkAccess.
export const BRIDGE_URL = 'ws://localhost:3055';

/** Tools in order of increasing cost (cost-ordered). */
export const TOOLS = {
  GET_SELECTION: 'figma_get_selection',
  GET_TREE: 'figma_get_tree',
  GET_TEXT: 'figma_get_text',
  GET_STYLES: 'figma_get_styles',
  INSPECT_NODE: 'figma_inspect_node',
  GET_SCREENSHOT: 'figma_get_screenshot',
} as const;
export type ToolName = (typeof TOOLS)[keyof typeof TOOLS];
export const TOOL_NAMES: readonly string[] = Object.values(TOOLS);

/** Notifications sent to the bridge. */
export const NOTIFY = {
  HELLO: 'figma/hello',
  SELECTION_CHANGED: 'figma/selection_changed',
  STYLES_INVALIDATED: 'figma/styles_invalidated',
} as const;

/** Internal code.ts -> ui.html notifications; NOT forwarded to the bridge (plugin/ prefix). */
export const LOCAL_NOTIFY = {
  PREFS: 'plugin/prefs',
  BENCH_BASELINE: 'plugin/bench_baseline',
} as const;
export const LOCAL_NOTIFY_PREFIX = 'plugin/';

/** Id prefix of requests created by the UI itself ("Copy slice"); their responses are not sent to the bridge. */
export const LOCAL_ID_PREFIX = 'ui:';

export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NODE_NOT_FOUND: -32001,
  SCREENSHOT_TOO_LARGE: -32002,
  TIMEOUT: -32003,
  UNSUPPORTED_NODE: -32004,
} as const;

/** Machine-readable causes in error.data.reason. */
export type RpcErrorReason =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | 'NODE_NOT_FOUND'
  | 'SCREENSHOT_TOO_LARGE'
  | 'TIMEOUT'
  | 'UNSUPPORTED_NODE';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: { reason: RpcErrorReason; [k: string]: unknown };
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

// ---------- Tool results ----------

/** figma_get_selection: `id|name|type` lines, empty selection -> []. */
export type SelectionResult = string[];

/** figma_get_tree / figma_get_text: line-based DSL. */
export type DslResult = string;

/**
 * figma_get_styles: up to STYLES_LIST_LIMIT names, a flat `names` list;
 * more: a `groups` overview (next path segment -> name count) plus `total`; the agent narrows with `prefix`.
 */
export interface StylesResult {
  names?: string[];
  total?: number;
  groups?: Record<string, number>;
  variablesUnavailable?: true;
}
export const STYLES_LIST_LIMIT = 100;

/** Screenshot sandbox -> UI: binary as a number array (postMessage cannot clone a Uint8Array). */
export interface ScreenshotSandboxResult {
  mimeType: 'image/png';
  width: number;
  height: number;
  size: number;
  bytes: number[];
}

/** Screenshot UI -> bridge: the same object, binary as base64. */
export interface ScreenshotWireResult {
  mimeType: 'image/png';
  width: number;
  height: number;
  size: number;
  data: string;
}

export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const EXPORT_TIMEOUT_MS = 10_000;

// ---------- Notification payloads ----------

export interface HelloParams {
  fileKey: string;
  fileVersion: string;
  pageId: string;
  pageName: string;
  selectionCount: number;
  pluginVersion: string;
}

/** figma/selection_changed: params is an array of `id|name|type` lines (top-level selected nodes only). */
export type SelectionChangedParams = string[];

export interface StylesInvalidatedParams {
  timestamp: number;
}

export interface UiPrefs {
  autoConnect: boolean;
  collapsed: boolean;
  /** UI language: 'auto' follows the system language. */
  lang: 'auto' | 'en' | 'ru';
}
export const DEFAULT_PREFS: UiPrefs = { autoConnect: true, collapsed: false, lang: 'auto' };

// ---------- dev token benchmark (docs/benchmark.md): UI <-> sandbox only, never sent to the bridge ----------

/** Baseline: size of exportAsync({ format: 'JSON_REST_V1' }), roughly what the Figma REST API returns. */
export interface BenchBaselineItem {
  nodeId: string;
  name: string;
  type: string;
  chars?: number;
  ms?: number;
  error?: string;
}

export interface BenchBaselineParams {
  requestId: string;
  items: BenchBaselineItem[];
}

// ---------- postMessage envelopes ----------

/** code.ts -> ui.html: the type discriminator is strictly "response" | "notify". */
export type SandboxToUi =
  | { type: 'response'; payload: JsonRpcResponse }
  | { type: 'notify'; payload: JsonRpcNotification };

/** ui.html → code.ts. */
export type UiToSandbox =
  | { type: 'rpc'; payload: unknown }
  | { type: 'ws_connected' }
  | { type: 'prefs_get' }
  | { type: 'prefs_set'; prefs: UiPrefs }
  | { type: 'resize'; width: number; height: number }
  | { type: 'bench_baseline'; requestId: string; nodeIds: string[] };
