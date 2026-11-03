<p align="center">
  <img src="docs/assets/logo-128.png" width="96" height="96" alt="Figma MCP Compact logo">
</p>

<h1 align="center">Figma MCP Compact</h1>

<p align="center">
  Give AI coding agents (Claude Code, Cursor, Claude Desktop) your Figma design —<br>
  in a compact line-based format that uses <b>~94% fewer tokens</b> than raw Figma JSON.
</p>

<p align="center"><a href="README.ru.md">Русская версия</a></p>

---

## Why

Feeding a design to an LLM usually means dumping Figma REST JSON: tens of thousands of tokens for a single screen, most of it noise. Figma MCP Compact answers the questions an agent actually asks with the cheapest tool that can answer them:

```text
0:768|Mobile|FRAME|3
  0:769|screen|GROUP|5
    0:772|app bar|GROUP|7
    0:784|status bar|GROUP|2
```

Measured on a real file: **55,708 tokens of REST JSON → 3,188 tokens** (−94%) for the same two frames, including the full tree, all texts and a detailed inspection. See [docs/benchmark.md](docs/benchmark.md).

## How it works

```text
MCP host ──stdio──▶ bridge (Spring AI, :3055) ◀──WebSocket── plugin UI ◀─postMessage─▶ plugin sandbox ─▶ Figma Plugin API
(Claude Code,         MCP server + cache                     (ui.html)                   (code.ts)
 Cursor, …)
```

- **Plugin** (`mcp-bridge-plugin/`) runs inside Figma Desktop, reads the document through the async Plugin API and answers JSON-RPC requests. Read-only: it never changes your file.
- **Bridge** (`bridge/`) is a local MCP server (Spring Boot + Spring AI) started by your MCP host over stdio. It talks to the plugin over a WebSocket on `localhost:3055` and caches design-system data.

## Tools (cheapest first)

| Tool | Parameters | Returns |
|---|---|---|
| `figma_get_selection` | — | Selected nodes: `id\|name\|type` per line, `[]` if nothing is selected |
| `figma_get_tree` | `nodeId?`, `maxDepth=2`, `pages?` | Hierarchy as `<indent><id>\|<name>\|<type>\|<childCount>[\|truncated:N]`; `pages:true` lists all pages |
| `figma_get_text` | `nodeId?` | Text layers as `<id>\|<path>\|<text>` (≤ 500 lines) + `skippedInstances: N` |
| `figma_get_styles` | `prefix?` | Style and variable names; above 100 names an overview of groups to drill into |
| `figma_inspect_node` | `nodeId`, `level=0..2`, `svg?` | Compact JSON: bounds, auto-layout, colors with style names, text, shadows, instance overrides, children; `svg:true` for icons |
| `figma_get_screenshot` | `nodeId`, `scale=1` | PNG as MCP image content (5 MB limit) |

Full output formats: [docs/protocol.md](docs/protocol.md).

## Quick start

Requirements: Figma Desktop (the free plan works), Node.js 20+, Java 25 + Maven, an MCP host (Claude Code, Cursor or Claude Desktop). Docker Desktop if you work in WSL (see below).

1. **Build the plugin**
   ```bash
   cd mcp-bridge-plugin && npm install && npm run build
   ```
2. **Import it into Figma:** open any design file → Plugins → Development → Import plugin from manifest… → `mcp-bridge-plugin/manifest.json`. Publishing is not needed: development plugins may connect to `localhost:3055`.
3. **Build the bridge**
   ```bash
   cd bridge && mvn package
   ```
4. **Register the MCP server** (the host starts the bridge itself):
   ```bash
   claude mcp add -s user figma-compact -- java -jar /ABS/PATH/bridge/target/figma-mcp-bridge-0.1.0.jar
   ```
   Cursor / Claude Desktop (`mcp.json` / `claude_desktop_config.json`):
   ```json
   { "mcpServers": { "figma-compact": { "command": "java", "args": ["-jar", "/ABS/PATH/bridge/target/figma-mcp-bridge-0.1.0.jar"] } } }
   ```
5. **Run the plugin** (Plugins → Development → Figma MCP Compact). The indicator turns green — "Connected (:3055)". Select a frame and ask your agent: *"What is selected in Figma?"*

### WSL: Figma on Windows, tools in WSL

Windows cannot reach services that listen on `127.0.0.1` inside WSL2 (NAT mode), so the plugin would keep retrying. Run the bridge in Docker instead — Docker Desktop publishes the port to Windows:

```bash
cd bridge && mvn package && docker build -t figma-mcp-bridge .
claude mcp add -s user figma-compact -- docker run -i --rm -p 127.0.0.1:3055:3055 figma-mcp-bridge
```

Check from PowerShell: `Test-NetConnection localhost -Port 3055`.

## Plugin UI

<p>
A small diagnostic panel: connection status, the live selection the agent sees, a request log, and quick actions — <b>Copy slice for AI</b> (paste a compact snapshot into any chat) and a dev token benchmark. English and Russian, switchable in ⚙ → Language.
</p>

## Security

Everything the tools return — layer names, texts, style names, SVG — is **untrusted data** written by whoever made the Figma file, including Community files. The MCP server instructs the model to treat it strictly as design content and never follow instructions found in it. The bridge listens on loopback only and rejects foreign `Origin`/`Host` headers. Details: [SECURITY.md](SECURITY.md).

## Development

```bash
cd mcp-bridge-plugin && npm run typecheck && npm test && npm run build   # plugin: unit tests
cd bridge && mvn package                                                 # bridge: unit tests + jar
node e2e/smoke.mjs                                                       # end-to-end: real bridge + plugin emulator + MCP client
node e2e/smoke.mjs --docker                                              # the same against the Docker image
```

The e2e test refuses to start while another bridge holds port 3055 (it would take the port over). See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Yellow/red indicator, "bridge not found" | The bridge is not running: check `/mcp` in your host (or Docker Desktop in WSL). |
| `Manifest error … must be a valid URL` | You use an old manifest with `127.0.0.1`; Figma only accepts host names. Re-import. |
| Agent gets `PLUGIN_NOT_CONNECTED` | The plugin window is closed — it only works while it is open. |
| Changes not visible | Plugin: `npm run build`, then reopen the plugin. Bridge: rebuild, then restart the MCP host. |

## License

[MIT](LICENSE)
