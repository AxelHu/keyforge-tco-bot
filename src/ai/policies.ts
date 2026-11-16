import type { CardView, LegalAction, Observation } from '../contracts/observation.js';
/** A policy gets only a player observation. Never pass full GameState or the shuffle seed. */
export type Policy = (observation: Observation) => string;
export function randomPolicy(next: () => number): Policy {
  return (o) => o.legalActions[Math.floor(next() * o.legalActions.length)].id;
}
function score(o: Observation, item: LegalAction): number {
  const a = item.action,
    me = o.players[o.you],
    opp = o.players[o.you === 0 ? 1 : 0];
  const visible = [
    ...(me.hand ?? []),
    ...me.battleline,
    ...me.artifacts,
    ...opp.battleline,
    ...opp.artifacts,
    ...(me.archives ?? []),
    ...me.discard,
    ...opp.discard,
    ...me.upgrades,
    ...opp.upgrades,
    ...me.purged,
    ...opp.purged,
    ...o.resolving,
    ...o.promptCards,
    ...o.underCards.flatMap((r) => r.cards ?? []),
    ...(o.prophecies ?? []).flatMap((r) => r.cards ?? []),
  ];
  const card = (id: string): CardView => visible.find((x) => x.id === id)!;
  switch (a.kind) {
    case 'activateProphecy':
      return card(a.card)?.spec.abilities?.fate?.length ? 2 : -8; // Own visible Fate only; never inspect an opponent latent card.
    case 'raiseTide':
      return -6; // Legal feature exposed; neutral baseline does not buy chains without a tide-aware policy.
    case 'keep':
      return 10;
    case 'mulligan':
      return -10;
    case 'payForge':
      return 90;
    case 'forge':
      return 100;
    case 'house':
      return (
        (me.hand ?? [])
          .filter((c) => c.effective.house === a.house)
          .reduce((n, c) => n + 1 + c.spec.amber, 0) +
        me.battleline.filter((c) => c.ready && c.effective.house === a.house).length * 2.5 +
        me.artifacts.filter((c) => c.ready && c.effective.house === a.house).length
      );
    case 'takeSomeArchives':
    case 'takeArchives':
      return 3;
    case 'leaveArchives':
      return 0;
    case 'play': {
      const c = card(a.copy ?? a.card);
      if (c.definition === 'miasma') return opp.amber >= opp.keyCost ? 30 : 1;
      return 5 + c.spec.amber * 3 + (c.spec.kind === 'creature' ? c.effective.power / 4 : 0);
    }
    case 'returnDiscard':
      return 3;
    case 'discard':
      return card(a.card)?.spec.returnFromDiscardCondition && me.discard.length >= 9 ? -6 : -3;
    case 'reap':
      return 6 + (me.amber < me.keyCost ? 3 : 0);
    case 'unstun':
      return 4;
    case 'use':
      return card(a.card).definition === 'library-of-babble' ? 7 : 3;
    case 'fight': {
      const c = card(a.card),
        t = card(a.target);
      if (t.effective.keywords.includes('elusive') && !t.elusiveUsed) return -4;
      const kill =
        c.effective.power >= t.effective.power - t.damage + Math.max(0, t.effective.armor - t.armorUsed);
      const survives =
        c.effective.keywords.includes('skirmish') || c.effective.power - c.damage > t.effective.power;
      return (kill ? t.effective.power + 3 : 0) + (survives ? 1 : -c.effective.power) - 2;
    }
    case 'select': {
      const c = card(a.target);
      if (!c) return 0; // Known deck/reveal-only choices are not assigned fabricated card values.
      if (o.pending?.kind === 'archive') return c.spec.house !== o.activeHouse ? 4 - c.spec.amber : -2;
      return c.controller !== o.you ? 5 + c.effective.power / 5 : -10;
    }
    case 'choose':
      return 0;
    case 'done':
      return -1;
    case 'order':
      return -a.index;
    case 'endTurn':
      return -5;
  }
}
export const greedyPolicy: Policy = (o) => {
  if (!o.legalActions.length) throw new Error('No decision for this player');
  return o.legalActions.reduce((best, a) => (score(o, a) > score(o, best) ? a : best)).id;
};
export interface DecisionRequest {
  protocol: 'keyforge-policy-v1';
  rulesVersion: string;
  catalogVersion: string;
  observation: Observation;
  deadlineMs: number;
}
export function decisionRequest(o: Observation, deadlineMs = 2000): DecisionRequest {
  return {
    protocol: 'keyforge-policy-v1',
    rulesVersion: o.rulesVersion,
    catalogVersion: o.catalogVersion,
    observation: structuredClone(o),
    deadlineMs,
  };
}
/** Shared contract for local models or a future authenticated Jev adapter.
 * Probabilities are action preferences, not win probabilities or calibrated confidence. */
export function acceptDecision(o: Observation, reply: { revision: number; actionId: string }): string {
  if (reply.revision !== o.revision) throw new Error('Stale model decision');
  if (!o.legalActions.some((a) => a.id === reply.actionId)) throw new Error('Model selected illegal action');
  return reply.actionId;
}
