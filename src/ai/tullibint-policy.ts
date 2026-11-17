/** Deck-specific, observation-only planning for the actual Tullibint composition. No hidden state or DoK score. */
import { rankLadder } from './ladder-policy.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { CardView, House, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
export const TULLIBINT_CARDS: Readonly<Record<string, number>> = Object.freeze({
  'island-of-misfit-toys': 1,
  'well-of-memory': 1,
  'dimo-elderghast': 2,
  tangler: 1,
  'veil-of-ectoplasm': 1,
  'be-our-geist': 1,
  darklamp: 1,
  'ecto-charge': 1,
  'hallowed-eve-festival': 1,
  'haunted-house': 1,
  reaver: 1,
  'badge-of-unity': 1,
  'corporal-bridger': 1,
  'prototype-harness': 1,
  'chief-engineer-walls': 1,
  'essence-entangler': 1,
  'into-the-warp': 1,
  'pyr*0': 1,
  'proton-siphon': 2,
  'sensor-chief-garcia': 1,
  'strength-from-diversity': 1,
  survey: 1,
  'world-tree': 1,
  cauldron: 1,
  'loyal-packmate': 1,
  rotfeast: 1,
  'dew-faerie': 1,
  'haunting-witch': 2,
  'lost-in-the-wild': 1,
  regrowth: 2,
  'skeletal-murmook': 1,
  'witch-of-the-spore': 1,
});
export type TullibintMode = 'engine' | 'conservative';
export function isTullibintObservation(o: Observation): boolean {
  const rows = o.players[o.you].deckList;
  return (
    rows.length === Object.keys(TULLIBINT_CARDS).length &&
    rows.every((r) => TULLIBINT_CARDS[r.definition] === r.count)
  );
}
export function rankTullibint(o: Observation, mode: TullibintMode = 'engine'): ActionAssessment[] {
  if (!isTullibintObservation(o))
    throw Error('Tullibint policy requires its exact public original card composition');
  const me = o.players[o.you],
    foe = o.players[1 - o.you],
    hand = me.hand ?? [];
  const view = new Map(
    [
      ...o.players.flatMap((p) => [
        ...(p.hand ?? []),
        ...(p.archives ?? []),
        ...p.battleline,
        ...p.artifacts,
        ...p.upgrades,
        ...p.discard,
        ...p.purged,
      ]),
      ...o.promptCards,
      ...o.resolving,
      ...o.underCards.flatMap((r) => r.cards ?? []),
    ].map((c) => [c.id, c]),
  );
  const cauldronChoice =
    o.pending?.intent?.kind === 'play-from-under' &&
    view.get(o.pending.source)?.definition === 'cauldron';
  const currentUnderCards = new Set(
    cauldronChoice
      ? (o.underCards.find((row) => row.source === o.pending!.source)?.cards?.map((c) => c.id) ??
        [])
      : [],
  );
  const own = (c: CardView) => c.controller === o.you;
  const active = (c: CardView, h: House | null = o.activeHouse) =>
    !!h && (c.effective.houses ?? [c.effective.house]).includes(h);
  const haunted = o.haunted?.[o.you] ?? me.discard.length >= 10;
  const dimos = me.battleline.filter(
    (c) => c.definition === 'dimo-elderghast' && !!c.spec.grantsAbilities?.length,
  );
  const witches = me.battleline.filter(
    (c) =>
      c.definition === 'haunting-witch' &&
      c.spec.reactions?.some((r) => r.event === 'creaturePlayed'),
  );
  const intercepted = [...foe.battleline, ...foe.artifacts].some(
    (c) => c.spec.capturesIncomingAmber,
  );
  const dimoMultiplier = haunted && !intercepted ? dimos.length : 0;
  const payoff = (c: CardView) => dimoMultiplier * c.captured;
  const ecto = hand.find((c) => c.definition === 'ecto-charge');
  const ectoCost = Math.max(6, me.keyCost + 20 - me.discard.length);
  const ectoSoon =
    !!ecto && !me.forgeBlocked && me.keys.length === 2 && me.amber + ecto.spec.amber >= ectoCost;
  const imminent =
    foe.keys.length === 2 &&
    !foe.forgeBlocked &&
    foe.skipForgeTurn !== o.turn + 1 &&
    foe.forgeAvailable >= foe.keyCost;
  const rotfeasts = o.lasting.filter(
    (e) => e.rule === 'anyCreatureDamagedGain' && e.actor === o.you && e.turn === o.turn,
  ).length;
  const cauldron = me.artifacts.find((c) => c.definition === 'cauldron');
  const coreValue = (c: CardView): number => {
    const table: Record<string, number> = {
      'dimo-elderghast': dimos.length ? 12 : 16,
      'haunting-witch': haunted ? 15 : 10,
      'hallowed-eve-festival': haunted ? 7 : 15,
      cauldron: cauldron ? 9 : 15,
      'haunted-house': haunted ? 12 : 9,
      'loyal-packmate': 9,
      'chief-engineer-walls': 11,
      'veil-of-ectoplasm': dimos.length ? 11 : 6,
      'ecto-charge': me.keys.length === 2 ? 18 : 10,
      regrowth: 8,
      'essence-entangler': dimos.length ? 11 : 6,
      'be-our-geist': haunted ? 11 : 4,
      'island-of-misfit-toys': 7,
      'well-of-memory': 8,
      'skeletal-murmook': haunted ? 10 : 6,
      tangler: 7,
      reaver: 7,
      'sensor-chief-garcia': imminent ? 14 : 7,
      'dew-faerie': 8,
      rotfeast: 6,
      'world-tree': 4,
      'witch-of-the-spore': 6,
      'pyr*0': 6,
      'badge-of-unity': 5,
      'proton-siphon': 4,
      'prototype-harness': 3,
      'into-the-warp': 4,
      'lost-in-the-wild': 4,
      survey: 7,
      'strength-from-diversity': dimos.length ? 8 : 4,
      'corporal-bridger': 7,
      darklamp: 6,
    };
    return table[c.definition] ?? (c.spec.kind === 'creature' ? 6 : 3);
  };
  const fragile = (c: CardView) => Math.max(1, c.effective.power - c.damage);
  const protectedCard = (c: CardView) =>
    ['dimo-elderghast', 'haunting-witch', 'chief-engineer-walls', 'loyal-packmate'].includes(
      c.definition,
    );
  const rawDamage = (c: CardView, n: number) =>
    !c.warded && !c.spec.invulnerable && !c.spec.cannotBeDamagedCondition
      ? Math.max(0, n - Math.max(0, c.effective.armor - c.armorUsed))
      : 0;
  function combat(a: CardView, t: CardView) {
    const noCombat = a.spec.noCombatDamage || t.spec.noCombatDamage;
    const elusive =
      t.effective.keywords.includes('elusive') && !t.elusiveUsed && !a.spec.ignoreTauntElusive;
    const hit = !noCombat && !elusive ? rawDamage(t, a.effective.power) : 0;
    const back =
      !noCombat && !elusive && !a.effective.keywords.includes('skirmish') && !t.spec.noDefenseDamage
        ? rawDamage(a, t.effective.power)
        : 0;
    const hazard = rawDamage(a, t.effective.hazardous);
    const dead =
      !a.warded &&
      !a.spec.invulnerable &&
      (back + hazard >= fragile(a) || (back > 0 && t.effective.keywords.includes('poison')));
    const kill =
      !t.warded &&
      !t.spec.invulnerable &&
      (hit >= fragile(t) || (hit > 0 && a.effective.keywords.includes('poison')));
    let damaged = Number(hit > 0) + Number(back > 0) + Number(hazard > 0);
    const position = foe.battleline.findIndex((c) => c.id === t.id);
    if ((a.effective.splashAttack ?? 0) > 0)
      for (const n of [position - 1, position + 1]) {
        const c = foe.battleline[n];
        if (c && rawDamage(c, a.effective.splashAttack ?? 0) > 0) damaged++;
      }
    return { dead, kill, damaged };
  }
  function captureScore(c: CardView): number {
    if (!own(c) || !me.battleline.some((t) => t.id === c.id)) return -100;
    let score = 2 + Math.min(c.effective.power, 6) * 0.2;
    if (dimoMultiplier) {
      const entangled = me.upgrades.some(
        (u) => u.attachedTo === c.id && u.definition === 'essence-entangler',
      );
      score += entangled ? 9 : 3;
      if (entangled && fragile(c) <= 1) score += dimoMultiplier * 4;
      else score += 6 / (fragile(c) + c.captured * 0.4);
      if (protectedCard(c)) score -= 4;
      if (c.ready && active(c) && foe.battleline.some((t) => combat(c, t).dead)) score += 6;
    } else if (protectedCard(c)) score += 1;
    return score;
  }
  const playValue = (c: CardView) =>
    coreValue(c) +
    (active(c) ? 4 : 0) +
    (c.spec.kind === 'creature' && haunted ? witches.length * 3 : 0);
  const rows = rankLadder(o, 'tactical', 'balanced');
  return rows
    .map((row) => {
      const item = o.legalActions.find((x) => x.id === row.actionId)!,
        a = item.action;
      const c = 'card' in a ? view.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card) : undefined;
      const target = 'target' in a ? view.get(a.target ?? '') : undefined;
      const src = view.get(o.pending?.source ?? '');
      let score = row.score,
        why: string[] = [];
      const add = (n: number, reason: string) => {
        score += n;
        why.push(reason);
      };
      // Actual legal forge actions and an explicitly recognized third-key play remain dominant.
      if (
        a.kind === 'forge' ||
        a.kind === 'payForge' ||
        (row.projectedKey && me.keys.length === 2 && row.score >= 100000)
      )
        return row;
      if (a.kind === 'house') {
        const h = a.house;
        const ownHand = hand.filter((x) => active(x, h));
        let gain = 0;
        if (h === 'geistoid') {
          if (ownHand.some((x) => x.definition === 'hallowed-eve-festival') && !haunted) gain += 14;
          if (ectoSoon) gain += 10000;
          gain +=
            ownHand.filter((x) => x.definition === 'dimo-elderghast').length * (haunted ? 6 : 3);
          if (
            haunted &&
            dimos.length &&
            me.battleline.some((x) => x.captured && x.ready && active(x, h))
          )
            gain += 6;
          if (
            me.discard.filter((x) => active(x, 'geistoid')).length >= 3 &&
            me.artifacts.some((x) => x.definition === 'island-of-misfit-toys' && x.ready)
          )
            gain += 4;
        }
        if (h === 'untamed') {
          const ws = ownHand.filter((x) => x.definition === 'haunting-witch').length;
          if (haunted) {
            gain +=
              (witches.length + ws) *
              Math.min(5, ownHand.filter((x) => x.spec.kind === 'creature').length) *
              2.8;
            gain += ownHand.filter((x) => x.definition === 'regrowth').length * 2;
          }
          if (!cauldron && ownHand.some((x) => x.definition === 'cauldron')) gain += 7;
        }
        if (h === 'staralliance') {
          if (
            dimoMultiplier &&
            ownHand.some((x) => x.definition === 'essence-entangler') &&
            me.battleline.some((x) => x.captured >= fragile(x))
          )
            gain += 9;
          if (
            me.discard.some((x) =>
              ['dimo-elderghast', 'proton-siphon', 'essence-entangler'].includes(x.definition),
            ) &&
            me.battleline.some((x) => x.definition === 'chief-engineer-walls' && x.ready)
          )
            gain += 4;
        }
        add(gain, 'deck engine-aware house choice');
      }
      if (a.kind === 'keep' || a.kind === 'mulligan') {
        const opener = hand.some((x) =>
          ['cauldron', 'hallowed-eve-festival', 'haunted-house'].includes(x.definition),
        );
        if (a.kind === 'keep')
          score = opener ? 8 : hand.filter((x) => x.spec.kind === 'creature').length >= 3 ? 2 : 0;
        else score = opener ? -2 : 3;
      }
      if (a.kind === 'play' && c) {
        if (c.spec.kind === 'creature') {
          if (haunted) add(witches.length * 3, 'actual creature-play income from active Witches');
          if (c.definition === 'haunting-witch')
            add(
              haunted
                ? 11 +
                    3 *
                      hand.filter((x) => x.id !== c.id && x.spec.kind === 'creature' && active(x))
                        .length
                : 4,
              'Witches before subsequent creatures',
            );
          if (c.definition === 'dimo-elderghast')
            add(haunted ? 9 : 5, 'two independent Dimo source boxes');
          if (c.definition === 'loyal-packmate' && (dimos.length || witches.length))
            add(5, 'protect critical non-Taunt engines');
        }
        const other = hand.filter((x) => x.id !== c.id && active(x));
        if (c.definition === 'cauldron')
          add(o.turn < 10 ? 12 : 7, 'cross-house plays, not just artifact board value');
        if (c.definition === 'haunted-house') add(haunted ? 12 : 8, 'repeatable any-house income');
        if (c.definition === 'hallowed-eve-festival')
          add(!haunted ? 15 : 3, 'fuel haunted before payoff');
        if (c.definition === 'ecto-charge' && !row.projectedKey)
          add(-25, 'retain unaffordable key cheat, do not spend it as one amber');
        if (c.definition === 'well-of-memory') {
          const good = me.discard.filter((x) => coreValue(x) >= 8);
          const junk = hand.filter((x) => x.id !== c.id && coreValue(x) <= 5);
          add(
            good.length && junk.length ? 8 : me.discard.length < 7 ? -4 : -1,
            'purge only replaceable pieces, preserve haunted-capable deck',
          );
        }
        if (c.definition === 'regrowth')
          add(
            me.discard.some((x) => x.definition === 'haunting-witch') && haunted
              ? 10
              : me.discard.some((x) => x.definition === 'dimo-elderghast')
                ? 5
                : 1,
            'recover engine instead of largest creature',
          );
        if (c.definition === 'be-our-geist')
          add(
            haunted &&
              me.discard.some((x) => ['dimo-elderghast', 'haunting-witch'].includes(x.definition))
              ? 10
              : 0,
            'actual replay activates Witch income',
          );
        if (c.definition === 'veil-of-ectoplasm')
          add(
            dimoMultiplier && me.battleline.length ? 8 : foe.amber === 0 ? -12 : 1,
            'captured amber can become engine payout',
          );
        if (c.definition === 'strength-from-diversity')
          add(dimoMultiplier ? 5 : 0, 'spread capture sets up Dimo');
        if (c.definition === 'rotfeast') {
          const fights = o.legalActions
            .filter((x) => x.action.kind === 'fight')
            .map((x) => x.action)
            .filter((x) => x.kind === 'fight');
          const best = Math.max(
            0,
            ...fights.map((f) => combat(view.get(f.card)!, view.get(f.target)!).damaged),
          );
          add(
            best >= 2 ? 10 + best * 2 : -3,
            'Rotfeast before splash/damage, not after creatures exhaust',
          );
        }
        if (c.definition === 'lost-in-the-wild') {
          const lost = haunted
            ? me.battleline.filter((_, i) => i < 2 || i >= me.battleline.length - 2)
            : me.battleline.filter((_, i) => i === 0 || i === me.battleline.length - 1);
          add(
            -lost.reduce((n, x) => n + coreValue(x) * 0.5 + x.captured * 2, 0),
            'shuffle is not Destroyed: no Dimo payout',
          );
        }
        if (c.definition === 'into-the-warp')
          add(
            me.battleline.reduce(
              (n, x) => n + (payoff(x) * 2 - x.captured - coreValue(x) * 0.3) * 0.5,
              0,
            ),
            'account for friendly wipe and Dimo payoff',
          );
        if (c.spec.kind === 'upgrade' && target) {
          if (c.definition === 'essence-entangler') {
            if (own(target))
              add(
                dimoMultiplier
                  ? target.captured >= fragile(target)
                    ? payoff(target) * 4 - target.captured * 2 - coreValue(target) * 0.7
                    : 8 / fragile(target) + (protectedCard(target) ? -7 : 2)
                  : -18,
                'Entangler can deliberately cash friendly captured amber',
              );
            else
              add(
                target.captured >= fragile(target)
                  ? target.captured * 2 + 3
                  : target.captured * 0.7,
                'enemy captured amber released only on actual removal',
              );
          } else if (!own(target)) add(-25, 'keep value upgrades on own creatures');
          else if (c.definition === 'proton-siphon')
            add(
              (target.effective.splashAttack ?? 0) > 0
                ? -4
                : Math.min(target.effective.power, 6) * 0.5 + 2,
              'spread splash instead of redundant stacking',
            );
          else if (c.definition === 'prototype-harness')
            add(protectedCard(target) ? 4 : 0, 'keep payoff sources alive');
          else if (c.definition === 'badge-of-unity')
            add(
              !active(target, 'staralliance') &&
                (target.definition === 'tangler' ||
                  target.definition === 'reaver' ||
                  target.definition === 'dew-faerie')
                ? 5
                : 0,
              'real additional-house use opportunities',
            );
        }
        if (c.spec.kind === 'creature' && a.flank) {
          const adjacent = a.flank === 'left' ? me.battleline[0] : me.battleline.at(-1);
          if (adjacent && protectedCard(adjacent))
            add(0.5, 'bury engine creature away from exposed flanks');
        }
        if (
          c.definition !== 'haunting-witch' &&
          c.spec.kind === 'creature' &&
          haunted &&
          other.some((x) => x.definition === 'haunting-witch')
        )
          add(-10, 'play available Witch before a non-Witch');
      }
      if (a.kind === 'use' && c) {
        if (c.definition === 'haunted-house')
          add(haunted ? 10 : -5, 'activate haunted Omni for actual income');
        if (c.definition === 'cauldron') {
          const held = o.underCards.find((x) => x.source === c.id);
          add(
            held && held.count >= 2 ? 13 : 7,
            'advance known Cauldron counter without assuming hidden top',
          );
          if (haunted && hand.some((x) => x.definition === 'haunting-witch' && active(x)))
            add(-18, 'deploy Witch before Cauldron creature plays');
          if (
            o.activeHouse === 'untamed' &&
            me.artifacts.some((x) => x.definition === 'world-tree' && x.ready) &&
            me.discard.some((x) => x.definition === 'haunting-witch') &&
            (held?.count ?? 0) < 3
          )
            add(-9, 'World Tree publicly seeds Cauldron before its Omni');
        }
        if (c.definition === 'world-tree')
          add(
            cauldron?.ready && me.discard.some((x) => x.definition === 'haunting-witch')
              ? 8
              : !haunted && me.discard.length >= 8
                ? -5
                : -2,
            'topdeck engine only when retrieval has a useful route',
          );
        if (c.definition === 'well-of-memory')
          add(
            me.discard.length === 9 ? 9 : -3,
            'destroy only for meaningful haunted threshold or later recycle',
          );
        if (c.definition === 'island-of-misfit-toys') {
          const returning = me.discard.filter((x) => active(x, 'geistoid'));
          const remain = me.discard.length - returning.length;
          add(
            returning.reduce((n, x) => n + coreValue(x) * 0.6, 0) -
              (haunted && remain < 10 ? 15 : 0) -
              (ecto && me.keys.length === 2 ? 12 : 0),
            'recover Geistoid package without casually undoing haunted/Ecto discount',
          );
        }
      }
      if (a.kind === 'reap' && c) {
        if (c.definition === 'reaver' && me.battleline.some((x) => x.captured > 0))
          add(4, 'extract real stored amber plus base reap');
        if (
          c.definition === 'chief-engineer-walls' &&
          me.discard.some((x) => x.definition === 'dimo-elderghast')
        )
          add(7, 'Walls retrieves Dimo robot');
        if (c.definition === 'tangler' && foe.battleline.some((x) => x.ready))
          add(2, 'stun engine and neighbors');
        if (
          rotfeasts &&
          o.legalActions.some((x) => x.action.kind === 'fight' && x.action.card === c.id)
        )
          add(-4, 'do not reap away a valuable Rotfeast fight');
      }
      if (a.kind === 'fight' && c && target) {
        const f = combat(c, target);
        if (f.dead) {
          add(
            payoff(c) * 4 - c.captured * 2,
            'friendly Destroyed payoff minus opponent returned amber',
          );
          if (protectedCard(c))
            add(-coreValue(c) * 0.7, 'preserve remaining engine unless cash-out is worth it');
        }
        if (rotfeasts)
          add(
            rotfeasts * f.damaged * 3.5,
            'Rotfeast counts actually damaged creatures, not damage points',
          );
        if (
          !rotfeasts &&
          hand.some((x) => x.definition === 'rotfeast' && active(x)) &&
          f.damaged >= 2
        )
          add(-13, 'cast Rotfeast before fighting');
      }
      if (a.kind === 'discard' && c) {
        if (['ecto-charge', 'cauldron', 'haunting-witch', 'dimo-elderghast'].includes(c.definition))
          add(-20, 'keep essential unassembled combo piece');
        else if (!haunted && me.discard.length >= 7 && coreValue(c) <= 6)
          add(3, 'reach haunted with expendable card');
      }
      if (a.kind === 'select' && target) {
        const op =
          o.pending?.intent?.kind === 'target-operation' ? o.pending.intent.operation : null;
        if (op === 'capture') score = captureScore(target);
        else if (op === 'takeAmber' && own(target))
          score = target.captured > 0 ? 5 + (protectedCard(target) ? 1 : 0) : -10;
        else if (op === 'returnHand' || op === 'deckTop') {
          if (me.discard.some((x) => x.id === target.id)) {
            score = playValue(target);
            if (haunted && me.discard.length === 10 && target.definition !== 'haunting-witch')
              score -= 4;
          }
        } else if (op === 'discard' && own(target)) {
          score = -coreValue(target) - (active(target) ? 3 : 0);
          if (
            target.definition === 'witch-of-the-spore' &&
            foe.battleline.some((x) => rawDamage(x, 3) >= fragile(x))
          )
            score += 8;
        } else if (src?.definition === 'well-of-memory') {
          if (hand.some((x) => x.id === target.id)) {
            const selected = o.pending?.selected ?? [];
            const remain = 36 - me.purged.length - selected.length;
            score = selected.includes(target.id)
              ? -100
              : coreValue(target) <= 5 && remain > 20 && me.discard.length > selected.length
                ? 6 - coreValue(target)
                : -20;
          } else if (me.discard.some((x) => x.id === target.id)) score = playValue(target);
        } else if (src?.definition === 'be-our-geist' && target.spec.kind === 'creature')
          score =
            playValue(target) +
            (target.definition === 'haunting-witch'
              ? 8
              : target.definition === 'dimo-elderghast'
                ? 6
                : 0);
        else if (
          src?.definition === 'chief-engineer-walls' &&
          me.discard.some((x) => x.id === target.id)
        )
          score = playValue(target);
        else if (cauldronChoice && currentUnderCards.has(target.id))
          score = playValue(target) + (target.definition === 'haunting-witch' ? 10 : 0);
        // Prevent a selected optional card from being toggled repeatedly by equal-value ranking.
        if (o.pending?.selected?.includes(target.id) && o.pending.kind !== 'damage') score = -100;
      }
      if (a.kind === 'done' && src?.definition === 'well-of-memory') score = 0;
      if (a.kind === 'choose' && cauldronChoice) {
        const option = o.pending?.options?.find((x) => x.id === a.option);
        const id = option?.source ?? a.option;
        const selected = currentUnderCards.has(id) ? view.get(id) : undefined;
        if (selected)
          score = playValue(selected) + (selected.definition === 'haunting-witch' ? 10 : 0);
      }
      if (mode === 'conservative' && score < 5000 && row.score < 5000)
        score = row.score + (score - row.score) * 0.65;
      // Recognized urgent denial survives ordinary engine-building adjustments.
      if (row.deniesKey && imminent && row.score >= 5000) score = Math.max(score, row.score);
      return {
        ...row,
        score,
        reasons: [...row.reasons, ...why],
        approximate: row.approximate || why.length > 0,
      };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export function tullibintPolicy(mode: TullibintMode = 'engine'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankTullibint(o, mode)[0].actionId;
  };
}
