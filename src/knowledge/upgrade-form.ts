/** Pure public attached-form knowledge projection. Never computes game state. */
import type { CardDefinition } from "../contracts/observation.js";
export function upgradeForm(d: CardDefinition, retained = false): CardDefinition {
  const upgrade = retained ? d.retainedUpgrade : d.playAsUpgrade;
  if (!upgrade) throw Error('Card has no declared alternate upgrade text');
  return {
    id: d.id,
    name: d.name,
    number: d.number,
    house: d.house,
    kind: 'upgrade',
    power: 0,
    armor: 0,
    amber: d.amber,
    ...(d.traits ? { traits: d.traits } : {}),
    summary: (retained ? 'Retained as an upgrade: ' : 'Played as an upgrade: ') + d.summary,
    ...(d.summaryFeatures !== undefined ? { summaryFeatures: d.summaryFeatures } : {}),
    ...(d.unmodeled ? { unmodeled: true as const } : {}),
    upgrade,
  };
}
