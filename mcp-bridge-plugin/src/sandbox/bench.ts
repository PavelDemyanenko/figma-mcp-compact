// Baseline for the dev benchmark (docs/benchmark.md): size of exportAsync({ format: 'JSON_REST_V1' }).
// The JSON itself is not sent to the UI (it can be megabytes), only its length.
import type { BenchBaselineItem } from '../shared/protocol';
import { NAME_MAX, truncate } from './dsl';
import { withTimeout } from './rpc';

const BASELINE_TIMEOUT_MS = 30_000;

export async function restJsonBaseline(nodeIds: string[]): Promise<BenchBaselineItem[]> {
  const items: BenchBaselineItem[] = [];
  for (const nodeId of nodeIds) {
    const item: BenchBaselineItem = { nodeId, name: '', type: '' };
    items.push(item);
    try {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) throw new Error('node not found');
      item.name = truncate(node.name, NAME_MAX);
      item.type = node.type;
      if (!('exportAsync' in node)) throw new Error(`${node.type} cannot be exported`);
      const t0 = Date.now();
      const json = await withTimeout(
        (node as SceneNode).exportAsync({ format: 'JSON_REST_V1' }),
        BASELINE_TIMEOUT_MS,
        'exportAsync(JSON_REST_V1)',
      );
      // Minified JSON is the fair baseline (no pretty-print indentation).
      item.chars = JSON.stringify(json).length;
      item.ms = Date.now() - t0;
    } catch (e) {
      item.error = e instanceof Error ? e.message : String(e);
    }
  }
  return items;
}
