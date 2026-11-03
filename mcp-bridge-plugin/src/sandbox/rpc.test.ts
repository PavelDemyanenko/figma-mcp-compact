import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR } from '../shared/protocol';
import { failure, isFailure, optInt, RpcError, validateRequest, withTimeout } from './rpc';

describe('validateRequest', () => {
  it('accepts a valid request', () => {
    const r = validateRequest({ jsonrpc: '2.0', id: 1, method: 'figma_get_tree', params: { maxDepth: 1 } });
    expect(isFailure(r)).toBe(false);
  });

  it.each([[{ jsonrpc: '2.0', method: 'x' }], [{ jsonrpc: '2.0', id: null, method: 'x' }], ['str'], [null], [[1]]])(
    'returns -32600 with id null when id is missing/invalid: %j',
    (raw) => {
      const r = validateRequest(raw);
      expect(isFailure(r) && r.id).toBe(null);
      expect(isFailure(r) && r.error.code).toBe(RPC_ERROR.INVALID_REQUEST);
    },
  );

  it('keeps id for other envelope errors', () => {
    const r = validateRequest({ jsonrpc: '1.0', id: 'a', method: 'x' });
    expect(isFailure(r) && r.id).toBe('a');
    const p = validateRequest({ jsonrpc: '2.0', id: 7, method: 'x', params: [1] });
    expect(isFailure(p) && p.error.code).toBe(RPC_ERROR.INVALID_PARAMS);
  });
});

describe('failure', () => {
  it('maps RpcError to {code,message,data.reason}', () => {
    const f = failure(3, new RpcError(RPC_ERROR.SCREENSHOT_TOO_LARGE, 'SCREENSHOT_TOO_LARGE', 'too big', { size: 9 }));
    expect(f.error).toEqual({ code: -32002, message: 'too big', data: { reason: 'SCREENSHOT_TOO_LARGE', size: 9 } });
  });
  it('maps unknown errors to -32603', () => {
    expect(failure(1, new Error('boom')).error.code).toBe(RPC_ERROR.INTERNAL_ERROR);
    expect(failure(1, 'x').error.message).toBe('x');
  });
});

describe('params', () => {
  it('validates integer ranges', () => {
    expect(optInt(undefined, 'level', 0, 0, 2)).toBe(0);
    expect(optInt({ level: 2 }, 'level', 0, 0, 2)).toBe(2);
    expect(() => optInt({ level: 3 }, 'level', 0, 0, 2)).toThrow(RpcError);
    expect(() => optInt({ level: 1.5 }, 'level', 0, 0, 2)).toThrow(RpcError);
  });
});

describe('withTimeout', () => {
  it('rejects with TIMEOUT', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => undefined), 10_000, 'exportAsync');
    vi.advanceTimersByTime(10_001);
    await expect(p).rejects.toMatchObject({ code: RPC_ERROR.TIMEOUT, reason: 'TIMEOUT' });
    vi.useRealTimers();
  });
  it('resolves when fast', async () => {
    await expect(withTimeout(Promise.resolve(5), 100, 'x')).resolves.toBe(5);
  });
});
