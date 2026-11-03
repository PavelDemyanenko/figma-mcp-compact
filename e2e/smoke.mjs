// E2E smoke test: the real bridge (JAR) + a plugin emulator over WebSocket + an MCP client over stdio.
// Run: node e2e/smoke.mjs            - JAR (after `mvn -f bridge/pom.xml package`)
//      node e2e/smoke.mjs --docker   - figma-mcp-bridge image (after `docker build -t figma-mcp-bridge bridge`)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Any version: the e2e test runs against whatever `mvn package` produced.
const TARGET = fileURLToPath(new URL('../bridge/target/', import.meta.url));
const JAR = TARGET + (readdirSync(TARGET).find((f) => /^figma-mcp-bridge-.*\.jar$/.test(f)) ?? 'figma-mcp-bridge.jar');
const DOCKER = process.argv.includes('--docker');
const BRIDGE_CMD = DOCKER
  ? ['docker', ['run', '-i', '--rm', '-p', '127.0.0.1:3055:3055', 'figma-mcp-bridge']]
  : ['java', ['-jar', JAR]];
// Like the real plugin: localhost (resolves to ::1 and 127.0.0.1; the bridge listens on 127.0.0.1 only).
const WS_URL = 'ws://localhost:3055';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function startBridge(tag) {
  const proc = spawn(BRIDGE_CMD[0], BRIDGE_CMD[1], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  const stdoutLines = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    stdoutLines.push(line);
    const msg = JSON.parse(line); // any non-JSON on stdout breaks the MCP protocol and fails the test
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`${tag}: ${method} timed out\n${stderr}`)), 40_000);
      pending.set(id, (m) => (clearTimeout(t), resolve(m)));
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { proc, rpc, notify, exited, stderr: () => stderr, stdoutLines };
}

async function waitForPort(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:3055/bridge/health');
      if (r.ok) return r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('bridge did not start');
}

function fakePlugin(calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.onerror = (e) => reject(e);
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'figma/hello', params: { fileKey: 'FILE1', fileVersion: 'session-1', pageId: '0:1', pageName: 'Page 1', selectionCount: 1, pluginVersion: '0.1.1' } }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'figma/selection_changed', params: ['12:34|Header Frame|FRAME'] }));
      resolve(ws);
    };
    ws.onmessage = (ev) => {
      const req = JSON.parse(ev.data);
      calls.push(req.method);
      const ok = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
      switch (req.method) {
        case 'figma_get_selection': return ok(['12:34|Header Frame|FRAME', '12:35|Submit Button|INSTANCE']);
        case 'figma_get_tree': return ok('0:1|Page 1|PAGE|1\n  12:34|Header Frame|FRAME|73|truncated:23');
        case 'figma_get_text': return ok('12:40|Header Frame/Title|Hello\nskippedInstances: 0');
        case 'figma_get_styles': return ok({ names: ['color/primary', 'text/heading/lg'] });
        case 'figma_inspect_node':
          if (req.params.nodeId === '404:1') {
            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: 'Node 404:1 not found', data: { reason: 'NODE_NOT_FOUND', nodeId: '404:1' } } }));
          }
          return ok({ id: req.params.nodeId, name: 'Submit Button', type: 'INSTANCE', bbox: [0, 0, 120, 40], mainComponentId: '1:1', componentName: 'Button/Primary' });
        case 'figma_get_screenshot': return ok({ mimeType: 'image/png', width: 1, height: 1, size: 70, data: PNG_1PX });
      }
    };
  });
}

const textOf = (r) => r.result.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

const results = [];
const check = async (name, fn) => {
  await fn();
  results.push(name);
  console.log('ok  -', name);
};

// The test starts its own bridge: if a working bridge (MCP session) holds the port, takeover would stop it.
const busy = await fetch('http://127.0.0.1:3055/bridge/health').then(() => true, () => false);
if (busy) {
  console.error('Port 3055 is used by a running bridge (a Claude Code / Cursor MCP session). Close it and retry,');
  console.error('otherwise the test would stop the working bridge via takeover.');
  process.exit(2);
}

const a = startBridge('A');
try {
  const health = await waitForPort();
  await check('bridge A listens on 127.0.0.1:3055', async () => assert.equal(health.service, 'figma-mcp-bridge'));

  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  a.notify('notifications/initialized', {});
  await check('MCP initialize', async () => assert.equal(init.result.serverInfo.name, 'figma-compact'));

  const list = await a.rpc('tools/list', {});
  await check('6 cost-ordered tools listed', async () =>
    assert.deepEqual(list.result.tools.map((t) => t.name), ['figma_get_selection', 'figma_get_tree', 'figma_get_text', 'figma_get_styles', 'figma_inspect_node', 'figma_get_screenshot']));

  const noPlugin = await a.rpc('tools/call', { name: 'figma_get_tree', arguments: {} });
  await check('PLUGIN_NOT_CONNECTED without plugin', async () => {
    assert.equal(noPlugin.result.isError, true);
    assert.match(textOf(noPlugin), /^PLUGIN_NOT_CONNECTED/);
  });

  const evil = await new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { Origin: 'https://evil.example' } });
    ws.onopen = () => resolve('open');
    ws.onerror = () => resolve('rejected');
  });
  await check('foreign Origin rejected', async () => assert.equal(evil, 'rejected'));

  const calls = [];
  const ws = await fakePlugin(calls);
  await sleep(300);

  const call = (name, args = {}) => a.rpc('tools/call', { name, arguments: args });
  await check('figma_get_selection → DSL lines', async () => assert.equal(textOf(await call('figma_get_selection')), '12:34|Header Frame|FRAME\n12:35|Submit Button|INSTANCE'));
  await check('figma_get_tree → DSL passthrough', async () => assert.match(textOf(await call('figma_get_tree', { maxDepth: 1 })), /truncated:23$/));
  await check('figma_get_text', async () => assert.match(textOf(await call('figma_get_text')), /skippedInstances: 0$/));

  const s1 = textOf(await call('figma_get_styles'));
  const s2 = textOf(await call('figma_get_styles'));
  await check('figma_get_styles cached (1 plugin call for 2 tool calls)', async () => {
    assert.equal(s1, '{"names":["color/primary","text/heading/lg"]}');
    assert.equal(s2, s1);
    assert.equal(calls.filter((c) => c === 'figma_get_styles').length, 1);
  });
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'figma/styles_invalidated', params: { timestamp: Date.now() } }));
  await sleep(200);
  await call('figma_get_styles');
  await check('styles_invalidated drops cache', async () => assert.equal(calls.filter((c) => c === 'figma_get_styles').length, 2));

  await check('figma_inspect_node → compact JSON', async () => {
    const t = textOf(await call('figma_inspect_node', { nodeId: '12:35', level: 1 }));
    assert.equal(JSON.parse(t).componentName, 'Button/Primary');
    assert.ok(!t.includes('\n') && !t.includes('"level"'));
  });
  await check('plugin error → isError with reason', async () => {
    const r = await call('figma_inspect_node', { nodeId: '404:1' });
    assert.equal(r.result.isError, true);
    assert.match(textOf(r), /^NODE_NOT_FOUND: Node 404:1 not found/);
  });
  await check('figma_get_screenshot → MCP image content', async () => {
    const r = await call('figma_get_screenshot', { nodeId: '12:34', scale: 2 });
    assert.equal(r.result.content[0].type, 'image');
    assert.equal(r.result.content[0].mimeType, 'image/png');
    assert.equal(r.result.content[0].data, PNG_1PX);
  });

  if (DOCKER) {
    // Docker: Docker itself rejects a busy port (port is already allocated), so takeover does not apply.
    a.proc.stdin.end();
    const code = await Promise.race([a.exited, sleep(20_000).then(() => 'timeout')]);
    await check('stdin EOF → container exits', async () => assert.equal(code, 0));
    await sleep(500);
    const free = await fetch('http://127.0.0.1:3055/bridge/health').then(() => false, () => true);
    await check('port 3055 released after container exit', async () => assert.ok(free));
    console.log(`\n${results.length} checks passed (docker)`);
    process.exit();
  }

  // The port is held by an "old" instance -> the new one takes it over (BindException -> takeover).
  const b = startBridge('B');
  const codeA = await Promise.race([a.exited, sleep(20_000).then(() => 'timeout')]);
  await check('second instance takes over port; first exits cleanly', async () => assert.equal(codeA, 0));
  await waitForPort();
  const initB = await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  await check('bridge B serves MCP', async () => assert.equal(initB.result.serverInfo.name, 'figma-compact'));

  b.proc.stdin.end();
  const codeB = await Promise.race([b.exited, sleep(15_000).then(() => 'timeout')]);
  await check('stdin EOF → bridge exits and frees port', async () => assert.equal(codeB, 0));

  await check('stdout contained only JSON-RPC', async () => assert.ok(a.stdoutLines.length > 0));
  console.log(`\n${results.length} checks passed`);
} catch (e) {
  console.error('FAILED:', e);
  console.error('--- bridge A stderr ---\n' + a.stderr().slice(-4000));
  process.exitCode = 1;
} finally {
  a.proc.kill();
}
process.exit();
