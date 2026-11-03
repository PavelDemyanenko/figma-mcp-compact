# Protocol

Two layers: **MCP** between the host and the bridge (stdio), and **JSON-RPC 2.0** between the bridge and the plugin (WebSocket `ws://localhost:3055`). Tool names and parameters are the same on both layers; the bridge forwards only known parameters. The single source of truth for the plugin side is [`mcp-bridge-plugin/src/shared/protocol.ts`](../mcp-bridge-plugin/src/shared/protocol.ts).

## JSON-RPC envelope

- Requests from the bridge: `{ "jsonrpc": "2.0", "id": "b17", "method": "figma_get_tree", "params": { … } }`.
- Every request gets exactly one response (`result` or `error`) — the plugin wraps each handler in `try/catch`.
- A request without a valid `id` gets error `-32600` with `"id": null`.
- Batches are not supported (`-32600`).

### Errors

`{ "code": number, "message": string, "data": { "reason": string, … } }`

| Code | `data.reason` | When |
|---|---|---|
| -32700 | `PARSE_ERROR` | Invalid JSON from the bridge |
| -32600 | `INVALID_REQUEST` | Bad envelope, missing `id`, batch |
| -32601 | `METHOD_NOT_FOUND` | Unknown method |
| -32602 | `INVALID_PARAMS` | Wrong parameter type or range |
| -32603 | `INTERNAL_ERROR` | Unexpected failure |
| -32001 | `NODE_NOT_FOUND` | `nodeId` does not exist |
| -32002 | `SCREENSHOT_TOO_LARGE` | PNG > 5 MB or > 32 MP before export; `data.suggestedScale` tells the agent what to retry with |
| -32003 | `TIMEOUT` | `exportAsync` took longer than 10 s |
| -32004 | `UNSUPPORTED_NODE` | e.g. `DOCUMENT`, or a node that cannot be exported |

The bridge turns errors into MCP tool errors (`isError: true`) with the text `<REASON>: <message> {extra data}`. Bridge-side reasons: `PLUGIN_NOT_CONNECTED`, `PLUGIN_DISCONNECTED`, `TIMEOUT`, `BUSY` (bulkhead full), `SEND_FAILED`.

### Notifications (plugin → bridge)

| Method | Params | When |
|---|---|---|
| `figma/hello` | `{ fileKey, fileVersion, pageId, pageName, selectionCount, pluginVersion }` | On every WebSocket connect and page switch |
| `figma/selection_changed` | `["id\|name\|type", …]` (top-level selected nodes) | Selection change (debounced 120 ms) |
| `figma/styles_invalidated` | `{ timestamp }` | `stylechange` — the bridge drops its styles cache |

`fileKey` is `local:<file name>`: the real file key is only exposed to private organization plugins, and a published Community plugin cannot use that API. `fileVersion` is a plugin session id (the Plugin API exposes no file version), so restarting the plugin always starts with a clean cache.

## DSL conventions

Line-based output (`figma_get_selection`, `figma_get_tree`, `figma_get_text`, level-2 children):

- Fields are separated by `|`. Inside names/paths/texts: `\` → `\\`, `|` → `\|`, line breaks → `\n`. Split on `/(?<!\\)\|/`.
- Names are cut at 80 characters, texts at 200 (by code point), with `…`.

## Tools

### `figma_get_selection`
Lines `id|name|type` for top-level selected nodes (a node whose ancestor is also selected is omitted). `[]` when nothing is selected.

### `figma_get_tree`
`nodeId?` (default: current page), `maxDepth` 0–10 (default 2).

```text
<indent><id>|<name>|<type>|<childCount>[|truncated:N]
```
Two spaces per level. `childCount` is the real number of children; at most 50 are listed, `truncated:N` reports the rest.

`pages: true` instead lists all pages: `<id>|<name>|PAGE[|current]`. Pass a page id as `nodeId` to explore it (the page is loaded on demand).

### `figma_get_text`
`nodeId?` (default: current page). Lines `<id>|<path>|<text>`, where `path` runs from the traversal root (excluded) to the node, `/`-separated. Empty texts are skipped. At most 500 lines, then `... truncated M more`. The last line is always `skippedInstances: N` — texts inside instances the API could not read.

### `figma_get_styles`
`prefix?`. Local paint/text/effect/grid styles plus local variables, deduplicated and sorted.

- Up to 100 names: `{ "names": [...] }`.
- More: `{ "total": N, "groups": { "<prefix>/<next segment>": count, … } }` — call again with a group as `prefix` to drill down. Prefix matching respects segment boundaries: `M3/sys/light` does not match `M3/sys/light-high-contrast/…`.
- `variablesUnavailable: true` when the variables API is not accessible.

The bridge caches responses per `fileKey + fileVersion + prefix` (LRU 200 entries, 1 h TTL) and drops them on `figma/styles_invalidated`.

### `figma_inspect_node`
`nodeId`, `level` 0–2 (default 0), `svg?`. Minified JSON; `level` is never echoed.

**Level 0**
- `id`, `name`, `type`, `childCount`, `visible: false` if hidden.
- `bbox: [x, y, w, h]`, rounded, in the coordinates of the nearest FRAME/COMPONENT/INSTANCE ancestor (GROUPs do not create a coordinate space).
- Rotated or flipped nodes add `rotation` (0–359), `flipped: true` and `visualBBox` — the visible bounds; `bbox` is then the pre-transform box.
- INSTANCE: `mainComponentId`, `componentName` (`Set/Variant` for variants), or `mainComponentUnavailable: true`.

**Level 1** adds
- `layout` (auto-layout): `mode`, `gap`, `padding [t, r, b, l]`, `align [primary, counter]`, `wrap`, `clip`; `sizing [horizontal, vertical]` (`FIXED`/`HUG`/`FILL`), `absolute: true`.
- `radius` (number or `[tl, tr, br, bl]`), `opacity`.
- `fills` / `strokes`: `#rrggbb`, `#rrggbbaa` when translucent, `"image"`; gradients, video and patterns are dropped. `fillStyleName`, `strokeStyleName`, `strokeWeight`, `strokeAlign` (if not INSIDE).
- `shadows`: CSS `box-shadow` strings `[inset ]x y blur spread #rrggbbaa`; `blur`, `backdropBlur`; `effectStyleName`.
- `text`: `characters` (≤ 2000), `font`, `size`, `lineHeight`, `letterSpacing`, `align`, `autoResize`, `case` (if not ORIGINAL), `decoration` (if not NONE), `styleName`. When styles vary within a text: `segments: [{ text, font, size, case?, decoration?, letterSpacing? }]` (≤ 20, adjacent identical runs merged).
- INSTANCE `overrides`: only direct changes against the main component, limited to `characters`, `fills`, `strokes`, `visible`; keyed by sublayer id (`self` for the instance), ≤ 50.

Fractional values (`gap`, `radius`, `strokeWeight`, font size) are rounded to 2 decimals.

**Level 2** adds `children: ["id|name|type|x,y,w,h[|hidden][|rot:N][|flipped]", …]` with visible bounds, ≤ 100, `truncatedChildren`.

**`svg: true`** adds `svg` — minified inline SVG (no `xmlns`, numbers to 2 decimals) for nodes up to 64×64 px and 4,000 characters, otherwise `svgSkipped` with the reason. Use it for icons whose shape the layer name does not tell.

### `figma_get_screenshot`
`nodeId`, `scale` 0.01–4 (default 1). Returns MCP image content (`image/png`, base64) plus a text line `PNG WxH, N KB`. Over 5 MB, or over 32 MP before export, fails with `SCREENSHOT_TOO_LARGE` and `suggestedScale`. Screenshots run one at a time.

## Plugin internals (sandbox ↔ UI)

`postMessage` from the sandbox to the UI always carries `type: "response" | "notify"`. Notifications prefixed `plugin/` (preferences, benchmark) stay inside the plugin. Binary data crosses `postMessage` as a plain number array (a `Uint8Array` cannot be cloned by the sandbox); the UI converts it to base64 for the WebSocket.
