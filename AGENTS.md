# AGENTS.md — instructions for AI coding agents

Context and rules for agents (Claude Code, Cursor, Copilot) working on this repository.

## Goal
A compact, token-efficient bridge between Figma and MCP hosts. Every design decision trades output size against what an agent needs to implement UI. Measured target: ≥ 80% fewer tokens than Figma REST JSON (currently −94%, [docs/benchmark.md](docs/benchmark.md)).

## Layout
- `mcp-bridge-plugin/` — Figma plugin (TypeScript, Vite, no UI framework).
  - `src/code.ts`, `src/sandbox/*` — QuickJS sandbox: JSON-RPC router and the 6 tools. `dsl.ts` and `rpc.ts` are pure and unit-tested.
  - `src/ui.html`, `src/ui.ts`, `src/i18n.ts` — iframe: WebSocket client, diagnostic UI, en/ru strings.
  - `src/shared/protocol.ts` — the single source of truth for the plugin contract.
- `bridge/` — Spring Boot 4.1 + Spring AI 2.0 MCP server (stdio) + WebSocket server on 127.0.0.1:3055.
- `e2e/smoke.mjs` — real bridge + plugin emulator + MCP client.
- `docs/` — [architecture](docs/architecture.md), [protocol](docs/protocol.md), [benchmark](docs/benchmark.md).

## Rules
1. **Protocol changes** (tool parameters/output, `protocol.ts`) update `docs/protocol.md` in the same change. New output fields cost tokens on every call: prefer opt-in parameters.
2. **Figma sandbox:** async Plugin API only (`getNodeByIdAsync`, `currentPage.loadAsync()`, `get*StylesAsync`). Forbidden: `findAll`/`findOne`, sync `getNodeById`, `loadAllPagesAsync`, `documentchange`. No WebSocket/DOM in `code.ts`. Build target es2017 (no `?.`/`??` in the sandbox output).
3. **Manifest:** `documentAccess: "dynamic-page"`, network access only to `localhost:3055`. Figma rejects IP addresses there.
4. **Errors:** every RPC in `code.ts` ends with a response (`try/catch`), shape `{ code, message, data.reason }`; a request without `id` gets `-32600` with `id: null`. `exportAsync` is raced against a 10 s timeout.
5. **postMessage:** sandbox → UI uses only `type: "response" | "notify"`; `plugin/*` notifications never reach the bridge. Binary data crosses as `Array.from(bytes)` inside a plain object.
6. **Bridge:** never write to stdout (it is the MCP stream). Every network entry point checks `Host`/`Origin`.
7. **Read-only:** tools never modify the document.
8. **UI strings** live in `src/i18n.ts` for both languages.
9. **Before handing over:** `npm run typecheck && npm test && npm run build` in `mcp-bridge-plugin/`, `mvn package` in `bridge/`, `node e2e/smoke.mjs` (needs a free port 3055).
