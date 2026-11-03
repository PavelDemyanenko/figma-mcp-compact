# Architecture

```text
MCP host ──stdio──▶ bridge (Spring AI, 127.0.0.1:3055) ◀──WebSocket── ui.html ◀─postMessage─▶ code.ts ─▶ Figma Plugin API
```

## Components

| Part | Where | Role |
|---|---|---|
| Plugin sandbox | `mcp-bridge-plugin/src/code.ts`, `src/sandbox/*` | Runs in Figma's QuickJS sandbox. JSON-RPC router and the 6 tools on the async Plugin API (`documentAccess: "dynamic-page"`). No network, no DOM. |
| Plugin UI | `src/ui.html`, `src/ui.ts`, `src/i18n.ts` | iframe: WebSocket client to `ws://localhost:3055`, exponential backoff (1 s → 30 s, never gives up), diagnostic panel. |
| Shared contract | `src/shared/protocol.ts` | Method names, error codes, message envelopes. |
| Bridge | `bridge/` | Spring Boot 4.1 + Spring AI 2.0 (MCP Java SDK 2.0). One process: MCP server over stdio + WebSocket server for the plugin. |

## Design decisions

**Cost-ordered tools.** Six tools from cheapest to most expensive. Line-based DSL instead of JSON where possible, progressive detail levels for inspection, no gradients/vector paths/unknown effects. Verified at −94% tokens against Figma REST JSON ([benchmark](benchmark.md)).

**Low-level MCP tool specs.** The bridge registers `SyncToolSpecification`s directly instead of `@Tool` annotations, so screenshots return native MCP `ImageContent` and schemas carry exact bounds (`minimum`/`maximum`/`enum`). The MCP server validates arguments against the schema before anything reaches Figma.

**Sessions.** Each connected plugin (one per open file) is a session. The active one is where the designer acted last (`figma/hello` or selection change). Calls whose result is tied to a file (styles cache) pin the session for the whole call.

**Bulkhead.** The Figma sandbox is single-threaded. At most 4 requests are in flight; screenshots take an extra exclusive slot (fixed acquisition order, no deadlock). Queue time counts against the same deadline, so a call never exceeds its timeout (15 s, screenshots 30 s). Overflow returns `BUSY` immediately.

**Port ownership.** The port is fixed at 3055 — the plugin and the manifest know only this one. Before Spring starts, `PortGuard` tries to bind it:
- held by another bridge instance (a "zombie" after an IDE restart) → it is asked to exit via `POST /bridge/shutdown`, then the port is reused;
- held by a foreign process → clear error, exit code 2 (`FIGMA_BRIDGE_PORT_CONFLICT=fail` disables takeover).

The bridge also exits on stdin EOF (the MCP host closed the session); otherwise Tomcat would keep the JVM alive.

**Local only.** The server binds `127.0.0.1`. WebSocket handshakes and service endpoints require `Host: localhost:3055|127.0.0.1:3055` (DNS rebinding) and an `Origin` of `null` (the plugin iframe) or `https://*.figma.com`. `/bridge/shutdown` requires a custom header, which forces a CORS preflight that is never allowed — web pages cannot reach it. A process of the same OS user can stop the bridge anyway (`kill`), so no token is used.

**stdout belongs to MCP.** All logging goes to stderr (`logback-spring.xml`, banner off). A single stray line on stdout would break the host's JSON-RPC stream; the e2e test fails on it.

**`localhost`, not `127.0.0.1`, in the manifest.** Figma rejects IP addresses in `networkAccess` ("must be a valid URL"). The browser resolves `localhost` to loopback and falls back from `::1` to `127.0.0.1`.

**Docker for WSL.** In WSL2 NAT mode Windows cannot reach `127.0.0.1` inside WSL, so Figma (on Windows) would never connect. The image listens on the container interface (`BRIDGE_ADDRESS=0.0.0.0`) and is published only on host loopback: `docker run -i --rm -p 127.0.0.1:3055:3055 figma-mcp-bridge`. `-i` carries stdio; stdin EOF ends the JVM (PID 1) and the container. The image is layered, runs as non-root and ships an AOT cache for faster cold start.

**Community-ready manifest.** `networkAccess.allowedDomains` lists only `localhost:3055` with a `reasoning`; no private plugin API (so `fileKey` falls back to the file name); Figma Design editor only — Dev Mode is not tested yet.

**Read-only.** No tool modifies the document. All Plugin API access is asynchronous (`getNodeByIdAsync`, `loadAsync`); `findAll`, `loadAllPagesAsync` and `documentchange` are not used.

**Localization.** The plugin UI is English and Russian (`src/i18n.ts`, Russian is the reference dictionary and English must implement every key). ⚙ → Language: Auto (system language) / English / Русский, stored in `figma.clientStorage`. Tool output for the agent is never localized.

## Limits

| What | Limit |
|---|---|
| Tree children listed per node | 50 |
| Text lines | 500 |
| Inspect children | 100 |
| Instance overrides | 50 |
| Text segments | 20 |
| SVG | ≤ 64×64 px, ≤ 4,000 chars |
| Screenshot | ≤ 5 MB PNG, ≤ 32 MP, scale 0.01–4, 10 s export timeout |
| Styles list before switching to groups | 100 |
| WebSocket text message | 8 MB |
