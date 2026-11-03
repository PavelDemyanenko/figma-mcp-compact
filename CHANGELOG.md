# Changelog

## 0.1.1 — 2026-11-03

Figma Community release candidate.

- Plugin manifest uses the Figma-issued plugin id and lists `localhost:3055` in `allowedDomains`, so the plugin also works when installed from Figma Community (not only as a development plugin).
- Removed the private plugin API: `fileKey` now falls back to the file name.
- Figma Design editor only (Dev Mode is not tested yet).
- e2e test finds the bridge jar regardless of version.

## 0.1.0 — 2026-11-03

First release.

- Figma plugin with six cost-ordered, read-only tools and a compact line-based DSL: −94% tokens vs Figma REST JSON on a real file.
- Spring AI MCP server (stdio) + WebSocket bridge on `localhost:3055`; multi-arch Docker image on ghcr.io for WSL and Java-free setups.
- Inspection covers auto-layout, colors with style names, typography with mixed-style segments, shadows, rotation/flip, instance overrides; opt-in SVG for icons; page list; style overview with prefix drill-down.
- Plugin UI in English and Russian; built-in token benchmark.
