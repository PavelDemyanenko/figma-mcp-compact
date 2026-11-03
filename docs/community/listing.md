# Figma Community listing

Everything needed for Plugins → Development → Figma MCP Compact → **Publish**.

| Field | Value |
|---|---|
| Name | Figma MCP Compact |
| Icon (128×128) | [`docs/assets/logo-128.png`](../assets/logo-128.png) |
| Cover (1920×1080) | [`docs/community/cover.png`](cover.png) |
| Carousel (1920×1080) | [`carousel-1-how-it-works.png`](carousel-1-how-it-works.png), [`carousel-2-tools.png`](carousel-2-tools.png) |
| Tagline | Your Figma design for AI coding agents — 94% fewer tokens than raw Figma JSON |
| Category | Development |
| Tags | mcp, ai, claude, cursor, developer handoff, code generation, design tokens, llm |
| Support contact | https://github.com/PavelDemyanenko/figma-mcp-compact/issues |
| Network access reasoning | Taken from `manifest.json` |

## Description

Figma MCP Compact lets AI coding agents — Claude Code, Cursor, Claude Desktop and any other MCP host — read your Figma design and turn it into code.

Instead of dumping tens of thousands of tokens of raw Figma JSON, the agent asks for exactly what it needs with six cost-ordered tools: the current selection, a compact layer tree, all texts, design-system style names, detailed inspection of one node (auto-layout, colors with style names, typography, shadows, component overrides) and, as a last resort, a PNG screenshot. On a real file this takes 94% fewer tokens.

**How it works**
The plugin connects to a small open-source bridge running on your own computer (localhost:3055). Your AI tool starts the bridge for you. Nothing is sent to any server — the design never leaves your machine except to the AI tool you already use.

**Setup (2 minutes)**
1. Add the bridge to your AI tool — one command, instructions on GitHub.
2. Run this plugin in your design file. The indicator turns green.
3. Select a frame and ask your agent: "Build this screen".

**Good to know**
- Read-only: the plugin never changes your file.
- Works on the free Figma plan.
- English and Russian interface.
- Open source (MIT): https://github.com/PavelDemyanenko/figma-mcp-compact

## Before submitting

- [ ] Repository and the ghcr.io package are public (the description links to them).
- [ ] A release with the Community manifest is published (`manifest.json` with id `1699527951382909616`).
- [ ] Tested by importing `mcp-bridge-plugin/manifest.json`: connects to the bridge with `allowedDomains` only (no `devAllowedDomains`).
