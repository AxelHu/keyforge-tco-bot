import type { Observation } from '../contracts/observation.js';

export interface NeutralReorderChoice {
  actionId: string;
  reason: 'keep-order' | 'commit-swap' | 'preserve-remaining-order' | 'complete-full-order';
}

/**
 * Position-neutral behavior for an explicit public reorder contract. No card text, hidden frame,
 * action synthesis or prompt-history guess is needed. Unknown or inconsistent inputs defer to the
 * registered policy; a two-card swap already selected is committed, never described as cancellation.
 */
export function neutralBattlelineReorder(o: Observation): NeutralReorderChoice | undefined {
  const q = o.pending,
    intent = q?.intent;
  if (
    q?.kind !== 'target' ||
    q.actor !== o.you ||
    intent?.kind !== 'battleline-reorder' ||
    (intent.player !== 0 && intent.player !== 1) ||
    (intent.mode !== 'full-order' && intent.mode !== 'swap-pair')
  )
    return;
  const line = o.players[intent.player].battleline,
    lineIds = new Set(line.map((c) => c.id)),
    selected = q.selected ?? [];
  if (
    !line.length ||
    lineIds.size !== line.length ||
    line.some((c) => c.controller !== intent.player) ||
    !Array.isArray(selected) ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !lineIds.has(id)) ||
    (q.selectedCount !== undefined && q.selectedCount !== selected.length)
  )
    return;
  const actions = o.legalActions,
    actionIds = new Set(actions.map((a) => a.id)),
    targets = new Map<string, string>(),
    done = actions.filter((a) => a.action.kind === 'done');
  if (!actions.length || actionIds.size !== actions.length || done.length > 1) return;
  for (const item of actions) {
    if (item.action.kind === 'done') continue;
    if (item.action.kind !== 'select') return;
    const id = item.action.target;
    if (!lineIds.has(id) || selected.includes(id) || targets.has(id)) return;
    targets.set(id, item.id);
  }
  if (intent.mode === 'swap-pair') {
    if ((q.max !== undefined && q.max !== 2) || selected.length > 2 || done.length !== 1) return;
    if (selected.length === 2) {
      if (intent.keepOrderActionId !== undefined || targets.size) return;
      return { actionId: done[0].id, reason: 'commit-swap' };
    }
    if (intent.keepOrderActionId !== done[0].id) return;
    return { actionId: done[0].id, reason: 'keep-order' };
  }
  // The complete order can cover a subset (for example an immovable source is excluded).
  if (
    intent.keepOrderActionId !== undefined ||
    !Number.isSafeInteger(q.max) ||
    q.max! < 1 ||
    q.min !== q.max ||
    selected.length + targets.size !== q.max
  )
    return;
  for (const card of line) {
    const actionId = targets.get(card.id);
    if (actionId !== undefined) return { actionId, reason: 'preserve-remaining-order' };
  }
  if (selected.length === q.max && done.length === 1)
    return { actionId: done[0].id, reason: 'complete-full-order' };
}
