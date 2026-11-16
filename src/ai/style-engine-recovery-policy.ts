/** Unrated engine-v2 candidate. Engine-v1 and every historical policy stay unchanged.
 * Remember only a recovery actually observed after our own proposed return. No
 * inferred Cemetery text, hidden state, match seed or rating is consulted.
 */
import type { Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
import { rankStylePolicy } from './style-policy.js';

export const ENGINE_RECOVERY_POLICY_IDS = ['tactical-style-engine-v2'] as const;
const SCYTHE = 'singing-scythe';

/** Create one instance per game, as for the other stateful code policies. */
export function engineRecoveryPolicyV2(): Policy {
  let epoch: { turn: number; you: number; revision: number } | undefined;
  let proposedReturn: { revision: number; card: string } | undefined;
  const recovered = new Set<string>();
  return (o: Observation) => {
    if (epoch && (o.turn !== epoch.turn || o.you !== epoch.you || o.revision < epoch.revision)) {
      recovered.clear();
      proposedReturn = undefined;
    }
    const me = o.players[o.you];
    if (proposedReturn && o.revision > proposedReturn.revision) {
      if ((me.hand ?? []).some((c) => c.id === proposedReturn!.card && c.definition === SCYTHE))
        recovered.add(proposedReturn.card);
      proposedReturn = undefined;
    }
    const ranked = rankStylePolicy(o, 'tactical-style-engine-v1');
    const legal = new Map(o.legalActions.map((a) => [a.id, a.action]));
    const normalMain = o.phase === 'main' && o.activePlayer === o.you && o.pending === null;
    const choice =
      ranked.find((row) => {
        const a = legal.get(row.actionId)!;
        return !(normalMain && a.kind === 'discard' && recovered.has(a.card));
      }) ?? ranked[0];
    const action = legal.get(choice.actionId)!;
    if (
      action.kind === 'returnDiscard' &&
      me.discard.some((c) => c.id === action.card && c.definition === SCYTHE)
    )
      proposedReturn = { revision: o.revision, card: action.card };
    epoch = { turn: o.turn, you: o.you, revision: o.revision };
    return choice.actionId;
  };
}
