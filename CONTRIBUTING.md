# Contributing

Issues and pull requests are welcome.

## Before you open a PR

```bash
cd mcp-bridge-plugin && npm run typecheck && npm test && npm run build
cd bridge && mvn package
node e2e/smoke.mjs                 # needs a free port 3055: close running MCP sessions first
```

If you change the Docker image: `docker build -t figma-mcp-bridge bridge && node e2e/smoke.mjs --docker`.

## Ground rules

- **Token cost first.** Every new field in a tool response costs tokens on every call. Prefer opt-in parameters (`svg`, `pages`, `prefix`) over growing the default output, and back changes with numbers from the built-in benchmark ([docs/benchmark.md](docs/benchmark.md)).
- **Protocol changes** (`mcp-bridge-plugin/src/shared/protocol.ts`, tool parameters or output) must update [docs/protocol.md](docs/protocol.md) in the same PR.
- **Figma sandbox:** asynchronous Plugin API only (`getNodeByIdAsync`, `loadAsync`, `get*StylesAsync`). No `findAll`/`findOne`, synchronous `getNodeById`, `loadAllPagesAsync` or `documentchange`. The sandbox build targets es2017.
- **Bridge:** nothing may write to stdout — it belongs to MCP. Every network entry point checks `Host`/`Origin`.
- **Read-only:** tools must never modify the user's document.
- **UI strings** go into `mcp-bridge-plugin/src/i18n.ts` for both languages; TypeScript fails the build if English misses a key.
