/** 原有的十二项文本启发式；默认直接读取原 summary。可选 mask 仅供兼容的自定义知识。 */
import type { CardDefinition } from '../contracts/observation.js';
export const TEXT_FEATURE_PATTERNS = [
  {
    "source": "steal|capture|skip.*forge|opponent.*lose|reduce each pool",
    "flags": "",
    "lower": true
  },
  {
    "source": "forge|steal|capture|draw",
    "flags": "i",
    "lower": false
  },
  {
    "source": "forge",
    "flags": "",
    "lower": false
  },
  {
    "source": "heal",
    "flags": "",
    "lower": true
  },
  {
    "source": "fully|full|all damage",
    "flags": "",
    "lower": true
  },
  {
    "source": "ready and|ready a|use a friendly",
    "flags": "",
    "lower": true
  },
  {
    "source": "capture",
    "flags": "",
    "lower": true
  },
  {
    "source": "return|destroy|purge|damage|stun",
    "flags": "",
    "lower": true
  },
  {
    "source": "destroy|purge|return",
    "flags": "",
    "lower": true
  },
  {
    "source": "steal|capture|destroy",
    "flags": "",
    "lower": false
  },
  {
    "source": "steal|capture|destroy|stun",
    "flags": "i",
    "lower": false
  },
  {
    "source": "draw|archive|return|forge",
    "flags": "i",
    "lower": false
  }
] as const;
export function summaryFeature(card: CardDefinition | undefined, index: number): boolean {
  if (!card) return false;
  const p = TEXT_FEATURE_PATTERNS[index];
  if (!p) throw Error('Unknown text feature');
  if (card.summaryFeatures !== undefined) return (card.summaryFeatures & (1 << index)) !== 0;
  return new RegExp(p.source, p.flags).test(p.lower ? card.summary.toLowerCase() : card.summary);
}
