// JSON-RPC 2.0: validation, errors, timeouts, parameter reading. No Figma API dependencies.
import {
  RPC_ERROR,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcErrorReason,
} from '../shared/protocol';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    readonly reason: RpcErrorReason,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const invalidParams = (message: string): RpcError =>
  new RpcError(RPC_ERROR.INVALID_PARAMS, 'INVALID_PARAMS', message);

export function failure(id: JsonRpcId | null, err: unknown): JsonRpcFailure {
  if (err instanceof RpcError) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: err.code, message: err.message, data: Object.assign({ reason: err.reason }, err.extra) },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    jsonrpc: '2.0',
    id,
    error: { code: RPC_ERROR.INTERNAL_ERROR, message: message || 'Internal error', data: { reason: 'INTERNAL_ERROR' } },
  };
}

const isValidId = (id: unknown): id is JsonRpcId =>
  (typeof id === 'string' && id.length > 0 && id.length <= 128) || (typeof id === 'number' && Number.isFinite(id));

/**
 * Validates the request envelope. Returns either a valid request or a ready error response.
 * A request without a valid id -> error -32600 with id: null.
 */
export function validateRequest(raw: unknown): JsonRpcRequest | JsonRpcFailure {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return failure(null, new RpcError(RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', 'Request must be a JSON object'));
  }
  const r = raw as Record<string, unknown>;
  if (!isValidId(r.id)) {
    return failure(null, new RpcError(RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', 'Missing or invalid "id"'));
  }
  if (r.jsonrpc !== '2.0') {
    return failure(r.id, new RpcError(RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', '"jsonrpc" must be "2.0"'));
  }
  if (typeof r.method !== 'string' || r.method.length === 0) {
    return failure(r.id, new RpcError(RPC_ERROR.INVALID_REQUEST, 'INVALID_REQUEST', 'Missing "method"'));
  }
  if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) {
    return failure(r.id, invalidParams('"params" must be an object'));
  }
  return { jsonrpc: '2.0', id: r.id, method: r.method, params: r.params as Record<string, unknown> | undefined };
}

export const isFailure = (r: JsonRpcRequest | JsonRpcResponse): r is JsonRpcFailure => 'error' in r;

/** Promise.race with a timeout; the timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError(RPC_ERROR.TIMEOUT, 'TIMEOUT', `${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ---------- parameter reading ----------

type Params = Record<string, unknown> | undefined;

export function optString(p: Params, key: string): string | undefined {
  const v = p ? p[key] : undefined;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) throw invalidParams(`"${key}" must be a non-empty string`);
  return v;
}

export function reqString(p: Params, key: string): string {
  const v = optString(p, key);
  if (v === undefined) throw invalidParams(`"${key}" is required`);
  return v;
}

export function optInt(p: Params, key: string, def: number, min: number, max: number): number {
  const v = p ? p[key] : undefined;
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalidParams(`"${key}" must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function optNumber(p: Params, key: string, def: number, min: number, max: number): number {
  const v = p ? p[key] : undefined;
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw invalidParams(`"${key}" must be a number in [${min}, ${max}]`);
  }
  return v;
}

export function optBool(p: Params, key: string, def: boolean): boolean {
  const v = p ? p[key] : undefined;
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw invalidParams(`"${key}" must be a boolean`);
  return v;
}
