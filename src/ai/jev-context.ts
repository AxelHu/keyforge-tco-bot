import type { CardView, Observation } from '../contracts/observation.js';
/** Fixed before the new evaluation set and before any new paid outputs were inspected. */
export const DEFAULT_CONTEXT_PROFILE: ContextProfile = 'rules-dynamic';
export const CONTEXT_VERSION = 'keyforge-primer-v1';
export const CONTEXT_PROFILES = [
  'baseline',
  'rules',
  'rules-dynamic',
  'rules-preferences',
  'rules-dynamic-preferences',
  'rules-static-preferences',
] as const;
export type ContextProfile = (typeof CONTEXT_PROFILES)[number];
export const BASIC_RULES = [
  'Win immediately by forging your third key. There is no player-health victory condition; eliminating enemy creatures does not itself win.',
  'A normal turn is: forge at most one key if affordable; choose one active house and optionally take all archives; play, discard and use cards in any legal order; ready your cards; refill your hand (normally to six); resolve end-of-turn effects. Then the opponent takes their turn.',
  'The normal forge step is at the START of a turn, not whenever amber reaches the cost. Default cost is six amber; use the supplied current costs and modifiers. A card can allow an extra off-step forge, still requiring its actual cost after resolving preceding effects.',
  'During the action phase, normally play/discard cards of the active house and use ready cards of that house. Abilities can grant exceptions; the supplied legal actions already include these exceptions and their distinct allowances.',
  'Cards normally enter play exhausted. Using a creature to reap, fight, or activate Action/Omni exhausts it; these are alternative uses, not all performed together. Ready effects may allow later uses. Discarding a card is not playing it.',
  'Playing a card normally costs no mana or energy. Resolve its printed bonus amber before its Play ability; actions resolve and go to discard, other types enter play. There is no general one-card-per-turn limit (the first turn is restricted, and the Rule of Six still applies).',
  'Resolve each instruction and choice before continuing. A legal action is not a promise its whole effect is affordable or useful; follow prerequisites and “if you did” in sequence, doing as much as permitted.',
  'Read the exact visible card descriptions and computed properties. Specific card effects can override these general rules. Unknown future draws/opponent hidden cards must not be assumed from the public deck list.',
] as const;
/** Heuristics, explicitly not rules and never conditioned on a case label or oracle outcome. */
export const STRATEGIC_PREFERENCES = [
  'Prefer an available guaranteed win over speculative future value. If no immediate win is available, prioritize preventing an otherwise immediate opponent third-key forge.',
  'Plan the order of legal actions: using a limited ready card or allowance now can prevent another action later. Check resource spending and prerequisites before committing.',
  'Outside immediate win/loss threats, balance amber generation, opponent amber control, useful board development and hand cycling. More damage, more cards, or more amber is not automatically best; account for timing and the opponent’s response.',
  'Preserve valuable resources when there is a concrete future benefit, but do not save an option at the price of losing immediately. These are tie-breaking priorities, not unconditional commands to attack, reap, steal or discard.',
] as const;
export const GLOSSARY = {
  reap: 'Reap: exhaust a ready eligible creature, gain 1 amber from the common supply, then resolve its After Reap abilities. Reaping is NOT activating an Action ability; those uses are alternatives.',
  action:
    'Action / use: exhaust the ready eligible card and resolve its specified Action ability, not its Reap ability. If a card offers multiple Action/Omni abilities, each use resolves only the selected one.',
  omni: 'Omni: a ready card may use its Omni ability on your turn regardless of active house. This exhausts it and resolves only that selected ability.',
  steal:
    'Steal: remove amber from the opponent’s POOL and add it to your pool, up to what they have. A prohibition or replacement can prevent/change stealing. Steal differs from reap, loss and capture.',
  capture:
    'Capture: remove amber from the opponent’s pool and put it on the capturing creature. This is not spendable pool amber unless a card allows it. When a creature leaves play, amber on it goes to the opponent of its controller, irrespective of the original source.',
  fight:
    'Fight: exhaust the attacker and choose an eligible enemy. Resolve Before Fight, attacker Assault and defender Hazardous; if either leaves play, skip the power-damage fight. Otherwise they deal damage equal to CURRENT POWER simultaneously, then a surviving attacker resolves After Fight abilities. Existing damage does not reduce power.',
  armor:
    'Armor: prevents its remaining amount of pending damage across the entire turn, not afresh for each hit. The supplied armorAvailable already subtracts armor used. Prevention differs from healing.',
  elusive:
    'Elusive: the first time that creature is chosen to be fought each turn, neither creature deals power-based fight damage. Assault, Hazardous and ability damage still apply. elusiveUsed=true means that first protection has already been consumed this turn.',
  skirmish:
    'Skirmish: while attacking, this creature does not take the defender’s power-based fight damage. It can still take Hazardous and ability damage; Skirmish does not protect it merely for being attacked.',
  poison:
    'Poison: one or more actual power-based fight damage from this creature destroys the damaged creature. If all damage is prevented, Poison does nothing. Poison does not apply to Assault, Hazardous or other ability damage.',
  assault:
    'Assault X: before the attacker’s normal fight damage, the attacking creature deals X damage to the defender. This can apply even against unused Elusive. A pre-fight death skips the later power-damage fight.',
  hazardous:
    'Hazardous X: before normal fight damage, the defending creature deals X damage to the attacker. This is not power damage and is not stopped by Skirmish or Elusive. Armor may prevent it.',
  taunt:
    'Taunt: a creature’s adjacent neighbors without Taunt cannot be chosen as fight targets while protected. It does not stop non-fight damage or targeting. Legal targets are already filtered by the engine.',
  stun: 'Stun: a stunned creature cannot fight, reap, or use Action/Omni. A legal use instead exhausts it to remove its stun, without the ordinary use effect. Other constant/triggered abilities still apply.',
  destroyed:
    'Destroyed: lethal damage or a destroy effect tags a card, then its Destroyed abilities resolve before it leaves play. Healing alone does not undo a destruction tag. An applicable “instead” replacement can prevent the destruction. Departing creatures release their stored amber.',
  sacrifice:
    'Sacrifice: destroy a card you control as instructed; Destroyed and leaving-play consequences apply. A sacrificed card cannot be used again unless returned appropriately.',
  archive:
    'Archive: move a card to the owner/holder’s private archives as the effect specifies. After choosing a house, you may take ALL your archives into hand; it is not an arbitrary-time draw. Foreign archived cards return to their owners when leaving the foreign archive.',
  purge:
    'Purge: put a card faceup in its owner’s purged area; this is not the discard pile and ordinary discard recovery cannot retrieve it. A card may explicitly track or return purged cards.',
  chains:
    'Chains: when refilling your hand, 1–6 chains reduce the refill target by 1, 7–12 by 2, 13–18 by 3, and 19–24 by 4. Shed one chain only if chains prevented a refill draw. Ordinary draw-card effects are not reduced by chains.',
  ready:
    'Ready / exhausted: only a ready eligible card can normally be used. Using it exhausts it. A ready effect changes exhausted to ready; it does not itself reap, fight or activate an ability unless explicitly instructed.',
  flank:
    'Flank / neighbor: flanks are the ends of the battleline; neighbors are immediately adjacent cards. Position can change power, protection and effect targets. A lone creature occupies both flanks.',
  ward: 'Ward: one external status counter prevents the next pending damage, destruction or other departure, then is removed. It does not stack. Ward granted after destruction tagging does not cancel that tag, but can still prevent another attempted movement.',
  enrage:
    'Enrage: when a creature is used, it must fight if that use permits a legal fight. A specific reap-only instruction can still reap. Remove enrage after actual use to fight, not merely unstunning. It does not stack.',
  exalt:
    'Exalt: place one amber from common supply on the creature. It is not a capture from the opponent pool. On normal departure, stored amber goes to the opponent of its then-controller.',
  ruleOfSix:
    'Rule of Six: during one turn, a player cannot play and/or use cards of the same name more than six times total across copies. Resolving a triggered effect is not by itself playing or using a card.',
  control:
    'Control / ownership: friendly/enemy refer to current controllers. Control changes do not change ownership. Cards normally leave play to their owner’s zone; stored amber follows the departure rule relative to current controller.',
  forge:
    'Forge / key cost: pay the current cost from legal payment sources to forge one key. In an ability, earlier gains/losses resolve first. An off-step forge is additional only if the ability permits it and resources remain sufficient.',
} as const;
export type GlossaryTerm = keyof typeof GLOSSARY;
const matchers: Partial<Record<GlossaryTerm, RegExp>> = {
  reap: /\breap\b/i,
  action: /\baction\b|\buse\b/i,
  omni: /\bomni\b/i,
  steal: /\bsteal\b|\bstolen\b/i,
  capture: /\bcaptur|stored.*amber/i,
  fight: /\bfight|combat/i,
  armor: /\barmor\b/i,
  elusive: /\belusive\b/i,
  skirmish: /\bskirmish\b/i,
  poison: /\bpoison\b/i,
  assault: /\bassault\b/i,
  hazardous: /\bhazardous\b/i,
  taunt: /\btaunt\b/i,
  stun: /\bstun/i,
  destroyed: /\bdestroy|\bleav.*play/i,
  sacrifice: /\bsacrific/i,
  archive: /\barchiv/i,
  purge: /\bpurg/i,
  chains: /\bchains?\b/i,
  ready: /\bready|\bexhaust/i,
  flank: /\bflank|\bneighbor|\badjacent|battleline/i,
  ward: /\bward/i,
  enrage: /\benrag/i,
  exalt: /\bexalt/i,
  ruleOfSix: /rule of six/i,
  control: /\bcontrol|owner/i,
  forge: /\bforge|key cost/i,
};
/** Only public/player-authorized, currently relevant cards and action types choose glossary entries.
 * The descriptions remain fixed: no action consequences, search, case IDs, rewards or labels. */
export function contextualTerms(o: Observation): GlossaryTerm[] {
  const own = o.players[o.you];
  const direct = [
    ...(own.hand ?? []),
    ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]),
    ...o.resolving,
    ...o.promptCards,
    ...o.underCards.flatMap((x) => x.cards ?? []),
    ...(o.phase === 'archives' ? (own.archives ?? []) : []),
  ];
  const refs = new Set(
    o.legalActions.flatMap((x) => Object.values(x.action).filter((s): s is string => typeof s === 'string')),
  );
  const historical = o.players
    .flatMap((p) => [...p.discard, ...p.purged, ...(p.archives ?? [])])
    .filter((c) => refs.has(c.id));
  const cards: CardView[] = [...new Map([...direct, ...historical].map((c) => [c.id, c])).values()];
  const text = cards.map((c) => [c.spec.summary, ...c.effective.keywords].join(' ')).join('\n');
  const set = new Set<GlossaryTerm>();
  for (const [term, pattern] of Object.entries(matchers))
    if (pattern!.test(text)) set.add(term as GlossaryTerm);
  for (const x of o.legalActions) {
    const k = x.action.kind;
    if (k === 'reap') set.add('reap');
    if (k === 'use') set.add('action');
    if (k === 'fight') set.add('fight');
    if (k === 'unstun') set.add('stun');
    if (k === 'forge' || k === 'payForge') set.add('forge');
    if (k === 'takeArchives' || k === 'leaveArchives') set.add('archive');
  }
  if (cards.some((c) => c.captured > 0)) set.add('capture');
  if (cards.some((c) => c.effective.armor > 0)) set.add('armor');
  if (cards.some((c) => c.effective.assault > 0)) set.add('assault');
  if (cards.some((c) => c.effective.hazardous > 0)) set.add('hazardous');
  if (cards.some((c) => c.stunned)) set.add('stun');
  if (cards.some((c) => c.warded)) set.add('ward');
  if (cards.some((c) => c.enraged)) set.add('enrage');
  if (o.players.some((p) => p.chains > 0)) set.add('chains');
  if (Object.values(o.turnUsage).some((n) => n > 0)) set.add('ruleOfSix');
  if (set.has('fight')) {
    set.add('armor');
    set.add('destroyed');
    set.add('ready');
  }
  if (set.has('reap') || set.has('action') || set.has('omni') || set.has('stun')) set.add('ready');
  return (Object.keys(GLOSSARY) as GlossaryTerm[]).filter((t) => set.has(t));
}
export function makeJevContext(o: Observation, profile: ContextProfile) {
  if (!CONTEXT_PROFILES.includes(profile)) throw new Error('Unknown Jev context profile');
  const terms = profile.includes('dynamic')
    ? contextualTerms(o)
    : profile.includes('static')
      ? (Object.keys(GLOSSARY) as GlossaryTerm[])
      : [];
  return {
    version: CONTEXT_VERSION,
    basicRules: [...BASIC_RULES],
    ...(terms.length ? { glossary: Object.fromEntries(terms.map((t) => [t, GLOSSARY[t]])) } : {}),
    ...(profile.includes('preferences') ? { strategicPreferences: [...STRATEGIC_PREFERENCES] } : {}),
  };
}
