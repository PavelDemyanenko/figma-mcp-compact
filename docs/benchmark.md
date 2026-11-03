# Token benchmark

The plugin has a built-in benchmark: ⚙ → **Compare tokens (dev)** with 1–5 frames selected. The report is written to the log and copied to the clipboard.

## Method

For each selected node:

- **Baseline:** `exportAsync({ format: 'JSON_REST_V1' })`, minified — roughly what the Figma REST API returns.
- **Plugin:** the sum of what an agent would get through the bridge: `figma_get_tree` (`maxDepth: 10`) + `figma_get_text` + `figma_inspect_node` (`level: 2`).
- **Tokens** are estimated as characters / 4 on both sides; the relative difference is what matters.

Part of the saving comes from data the DSL drops on purpose (gradients, vector paths, children beyond 50 per node). The report breaks the plugin side down by tool.

## Results

Material Design sticker sheet (Figma Community), 2026-11-03:

| Frame | REST JSON | Plugin (tree · text · inspect) | Saving |
|---|---|---|---|
| Desktop | 32,339 | 1,749 (1,525 · 169 · 55) | −95% |
| Tablet 9inch | 23,369 | 1,440 (1,203 · 181 · 57) | −94% |
| **Total** | **55,708** | **3,188** | **−94%** |

The benchmark inspects only the root. Detailed implementation inspects more nodes at level 1 (~60–100 tokens each); even 20 extra calls keep the saving around 90%.

## Is the data enough to build the UI?

Two frames were implemented from plugin data only and compared pixel by pixel with Figma screenshots:

- an absolutely positioned Material Design mobile frame (HTML/CSS): 1.5% of pixels differ — designer redlines that were intentionally skipped, a dropped shadow (effects were not emitted back then; they are now), and font anti-aliasing;
- a Material 3 auto-layout card (React + Tailwind): 1.9% — font anti-aliasing and transparent PNG corners. Auto-layout maps 1:1 to flexbox.

Both took about 2,000 tokens of tool output.
