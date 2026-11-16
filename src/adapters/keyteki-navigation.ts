/** Memory for external UI navigation only. No rule inference, card-value tuning or hidden state.
 * Menus are learned from actual player prompts. A policy-cancelled Play route is not retried
 * against the same main-window position; a previously offered Discard route remains available.
 * Declining the complete outer Use menu also suppresses only that unchanged entry.
 */
import { createHash } from 'node:crypto';
import { canonical } from '../shared/canonical.js';
import type { Action, LegalAction } from '../contracts/observation.js';
import {
  projectKeytekiState,
  type KeytekiCommand,
  type KeytekiProjection,
  type KeytekiProjectionOptions,
  type KeytekiProphecyActivation,
  type KeytekiResolvingPlaySource,
} from './keyteki.js';

type RouteKind = 'play' | 'play-as-upgrade' | 'discard' | 'returnDiscard';
interface MenuKnowledge {
  actions: LegalAction[];
  cancelled: Set<RouteKind>;
}
interface Flight {
  source: string;
  requested?: Action;
  branch?: RouteKind;
  sawPrompt: boolean;
  untouchedUseMenu?: boolean;
}
interface ResolvingPlayFlight {
  source: KeytekiResolvingPlaySource;
  menuPrompt: string;
  effectPrompt?: string;
}
interface CurrentView {
  prompt: string;
  fingerprint: string;
  main: boolean;
  cancelIds: Set<string>;
  position: string;
  endTurnEntryId?: string;
  endTurnConfirmationId?: string;
  declinedUseSource?: string;
}
interface EndTurnFlight {
  position: string;
  confirmationUuid?: string;
}
interface ProphecyFlight extends KeytekiProphecyActivation {
  sawPrompt: boolean;
  cancelled?: boolean;
}
const hash = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
const route = (a: Action): RouteKind | undefined => {
  if (a.kind === 'play') return a.asUpgrade === true ? 'play-as-upgrade' : 'play';
  return a.kind === 'discard' || a.kind === 'returnDiscard' ? a.kind : undefined;
};
const sameAction = (a: Action, b: Action) => canonical(a) === canonical(b);
function promptEvidence(raw: unknown, playerName: string) {
  const me = (raw as { players?: Record<string, Record<string, unknown>> } | null)?.players?.[playerName];
  const menu = me?.menuTitle as { text?: unknown; values?: { amount?: unknown } } | undefined;
  const giftPrompt =
    me?.activePlayer === true &&
    me.phase === 'main' &&
    me.selectOrder === false &&
    me.selectCard === true &&
    me.promptTitle === 'A Gift of Æmber' &&
    menu?.text === 'Choose {{amount}} creatures' &&
    menu.values?.amount === 2;
  // Selection highlighting can change control targets in the same Gift prompt.
  // Keep the actual source/UUID/buttons in the signature; the projector validates
  // the complete current legal creature domain and selected prefix on every view.
  const controls =
    giftPrompt && Array.isArray(me?.controls)
      ? me.controls.map((control: unknown) => {
          if (!control || typeof control !== 'object') return control;
          const { targets: _targets, ...identity } = control as Record<string, unknown>;
          return identity;
        })
      : me?.controls;
  return {
    signature: hash([me?.promptTitle, me?.menuTitle, me?.selectCard, me?.selectOrder, controls, me?.buttons]),
    definition:
      me?.activePlayer === true && me?.phase === 'main' && me?.selectOrder === false
        ? me?.promptTitle === 'They Tell No Tales' &&
          me?.menuTitle === 'Choose a house' &&
          me?.selectCard === false
          ? 'they-tell-no-tales'
          : me?.promptTitle === 'Divine Seal' &&
              me?.menuTitle === 'Choose a creature' &&
              me?.selectCard === true
            ? 'divine-seal'
            : giftPrompt
              ? 'a-gift-of-æmber'
              : undefined
        : undefined,
  };
}
function refreshFingerprint(p: KeytekiProjection): void {
  p.fingerprint = hash({
    gameId: p.gameId,
    playerName: p.playerName,
    observation: p.observation,
    commands: p.commands,
    unsupported: p.unsupported,
  });
}
function retain(p: KeytekiProjection, actions: LegalAction[]): void {
  const ids = new Set(actions.map((a) => a.id));
  p.observation.legalActions = actions;
  p.commands = Object.fromEntries(Object.entries(p.commands).filter(([id]) => ids.has(id)));
  p.navigationActionIds = p.navigationActionIds.filter((id) => ids.has(id));
}
// The native End Turn confirmation changes only the available buttons. Reuse an
// already selected action only while every other projected fact stays identical.
function endTurnPosition(p: KeytekiProjection): string {
  return hash({
    gameId: p.gameId,
    playerName: p.playerName,
    observation: { ...p.observation, revision: 0, legalActions: [] },
  });
}
function mainPosition(p: KeytekiProjection): string {
  const o = p.observation;
  // Prompt UUIDs, selection highlighting, current response revision and chat do not alter
  // card utility. Visible resources, hand/board identities, counts, effects and available
  // card-entry affordances do. Check only on actual main-window views, never mid-resolution.
  return hash({
    match: p.gameId,
    player: p.playerName,
    turn: o.turn,
    publicStateCoverage: o.publicStateCoverage,
    activeHouse: o.activeHouse,
    activePlayer: o.activePlayer,
    players: o.players,
    tide: o.tide,
    prophecies: o.prophecies,
    underCards: o.underCards,
    cardEffects: o.cardEffects,
    lasting: o.lasting,
    permissions: o.permissions,
    houseRestrictions: o.houseRestrictions,
    futureHouseRestrictions: o.futureHouseRestrictions,
    entries: o.legalActions
      .filter((a) => p.commands[a.id]?.message === 'cardClicked')
      .map((a) => a.action)
      .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')),
  });
}
export class KeytekiNavigation {
  private identity?: string;
  private anchor?: string;
  private menus = new Map<string, MenuKnowledge>();
  private flight?: Flight;
  private prophecyFlight?: ProphecyFlight;
  private endTurnFlight?: EndTurnFlight;
  private cancelledProphecies = new Set<string>();
  private declinedUseMenus = new Set<string>();
  private prophecyFailure?: string;
  private commandSourceCardId?: string;
  private resolvingPlayFlight?: ResolvingPlayFlight;
  private lastClickedCardId?: string;
  private sourceBindingInvalidated = false;
  private current?: CurrentView;
  private recorded = new Set<string>();
  private count = {
    menusLearned: 0,
    cancelledPaths: 0,
    discardRoutesExposed: 0,
    continuedRoutes: 0,
    cacheResets: 0,
  };
  private exposed = new Set<string>();
  summary() {
    return { ...this.count, cachedCards: this.menus.size };
  }
  reset(): void {
    this.identity = undefined;
    this.anchor = undefined;
    this.menus.clear();
    this.flight = undefined;
    this.prophecyFlight = undefined;
    this.endTurnFlight = undefined;
    this.cancelledProphecies.clear();
    this.declinedUseMenus.clear();
    this.prophecyFailure = undefined;
    this.commandSourceCardId = undefined;
    this.resolvingPlayFlight = undefined;
    this.lastClickedCardId = undefined;
    this.sourceBindingInvalidated = false;
    this.current = undefined;
    this.recorded.clear();
    this.exposed.clear();
  }
  project(raw: unknown, options: KeytekiProjectionOptions): KeytekiProjection {
    const identity = canonical([(raw as { id?: unknown } | null)?.id, options.playerName]);
    if (this.identity !== identity) {
      this.reset();
      this.identity = identity;
    }
    const prompt = promptEvidence(raw, options.playerName);
    const resolving = this.resolvingPlayFlight;
    if (resolving) {
      const bound = resolving.source;
      if (
        bound.turn !== options.turn ||
        bound.playerName !== options.playerName ||
        bound.gameId !== (raw as { id?: unknown } | null)?.id ||
        this.sourceBindingInvalidated ||
        this.commandSourceCardId !== bound.id ||
        (options.sourceCardId !== undefined && options.sourceCardId !== bound.id) ||
        this.prophecyFlight ||
        (resolving.effectPrompt
          ? prompt.signature !== resolving.effectPrompt || prompt.definition !== bound.definition
          : prompt.definition !== bound.definition && prompt.signature !== resolving.menuPrompt)
      )
        this.resolvingPlayFlight = undefined;
      else if (prompt.definition === bound.definition) resolving.effectPrompt = prompt.signature;
    }
    const p = projectKeytekiState(raw, {
      ...options,
      // Flight tracks the original Play/Discard route, which can invoke another card's use.
      // Keep physical command-source binding separate from that outer navigation route.
      sourceCardId: this.sourceBindingInvalidated
        ? undefined
        : (this.commandSourceCardId ?? options.sourceCardId ?? this.flight?.source),
      lastClickedCardId:
        this.lastClickedCardId ?? (this.sourceBindingInvalidated ? undefined : options.lastClickedCardId),
      prophecyActivation: this.prophecyFlight,
      resolvingPlaySource: this.resolvingPlayFlight?.source,
    });
    if (this.resolvingPlayFlight?.effectPrompt) {
      const pending = p.observation.pending;
      const source = this.resolvingPlayFlight.source;
      const expected =
        pending?.source === source.id &&
        (source.definition === 'they-tell-no-tales'
          ? pending.options?.some((option) => option.house !== undefined)
          : source.definition === 'a-gift-of-æmber'
            ? pending.min === 0 &&
              pending.max === 2 &&
              pending.intent?.kind === 'target-operation' &&
              pending.intent.operation === 'destroy'
            : pending.intent?.kind === 'target-operation' && pending.intent.operation === 'deckBottom');
      if (!expected) this.resolvingPlayFlight = undefined;
    }
    const input = raw as {
      players?: Record<
        string,
        {
          activePlayer?: boolean;
          selectCard?: boolean;
          selectOrder?: boolean;
          menuTitle?: unknown;
          promptTitle?: unknown;
          controls?: { uuid?: string }[];
          buttons?: {
            text?: unknown;
            arg?: unknown;
            uuid?: string;
            command?: string;
            method?: unknown;
            disabled?: boolean;
          }[];
        }
      >;
    };
    const me = input.players?.[p.playerName];
    const isEndTurnConfirmation = me?.menuTitle === 'Are you sure you want to end your turn?';
    const isMain =
      !isEndTurnConfirmation &&
      p.observation.phase === 'main' &&
      p.observation.legalActions.some((a) => a.action.kind === 'endTurn');
    const position = endTurnPosition(p);
    let endTurnConfirmationId: string | undefined;
    let declinedUseSource: string | undefined;
    if (this.endTurnFlight) {
      const flight = this.endTurnFlight;
      if (position !== flight.position || (!isMain && !isEndTurnConfirmation)) {
        this.endTurnFlight = undefined;
      } else if (isEndTurnConfirmation) {
        const buttons = me?.buttons ?? [],
          uuid = buttons[0]?.uuid;
        const bound =
          me?.activePlayer === true &&
          me.promptTitle === 'End Turn' &&
          me.selectCard === false &&
          me.selectOrder === false &&
          Array.isArray(me.controls) &&
          me.controls.length === 0 &&
          buttons.length === 2 &&
          typeof uuid === 'string' &&
          uuid.length > 0 &&
          (!flight.confirmationUuid || flight.confirmationUuid === uuid) &&
          buttons.every(
            (b) =>
              b.uuid === uuid &&
              b.command === 'menuButton' &&
              b.method === undefined &&
              b.disabled !== true &&
              ((b.arg === 0 && b.text === 'Yes') || (b.arg === 1 && b.text === 'No')),
          ) &&
          new Set(buttons.map((b) => b.arg)).size === 2;
        const continuation =
          bound &&
          p.observation.legalActions.find(
            (a) =>
              a.action.kind === 'endTurn' &&
              p.commands[a.id]?.message === 'menuButton' &&
              canonical(p.commands[a.id].args) === canonical([0, uuid]),
          );
        if (continuation) {
          flight.confirmationUuid = uuid;
          retain(p, [continuation]);
          endTurnConfirmationId = continuation.id;
          p.unknown.push('navigation-memory: confirm the selected End Turn at the unchanged position');
        } else this.endTurnFlight = undefined;
      }
    }
    const prophecyPrompt =
      me?.menuTitle === 'Activate prophecy?' ||
      me?.menuTitle === 'Choose a card from your hand to place under the prophecy';
    if (this.prophecyFlight) {
      const flight = this.prophecyFlight;
      const stored = p.observation.prophecies
        ?.find((slot) => slot.id === flight.action.slot)
        ?.cards?.some((card) => card.id === flight.action.card);
      if (prophecyPrompt) {
        flight.sawPrompt = true;
        const matching = p.observation.legalActions.find(
          (a) => sameAction(a.action, flight.action) && p.commands[a.id]?.intent === 'prophecy',
        );
        if (matching) {
          if (me?.menuTitle === 'Activate prophecy?')
            flight.confirmationUuid ??= String(p.commands[matching.id].args[1]);
          else flight.placementUuid ??= me?.controls?.[0]?.uuid;
          // Keep the exact No offered by this confirmation prompt. It cancels the
          // whole selected route; it is not an administrative refusal or a new latent choice.
          const cancel = p.observation.legalActions.filter(
            (a) => a.action.kind === 'done' && p.commands[a.id]?.intent === 'prophecy',
          );
          retain(p, flight.cancelled ? cancel : [matching, ...cancel]);
          p.unknown.push('navigation-memory: continue the selected physical prophecy and own latent card');
        }
      } else if (stored) {
        this.prophecyFlight = undefined;
      } else if (isMain && flight.sawPrompt) {
        if (flight.stage === 'place') this.prophecyFailure = 'prophecy-latent-placement-not-observed';
        else this.cancelledProphecies.add(canonical(flight.action));
        this.prophecyFlight = undefined;
      }
    }
    if (this.prophecyFailure) p.unsupported.push(this.prophecyFailure);
    if (isMain) {
      const position = mainPosition(p);
      if (this.anchor !== position) {
        if (this.anchor !== undefined) {
          this.count.cacheResets++;
          this.menus.clear();
          this.exposed.clear();
          this.cancelledProphecies.clear();
          this.declinedUseMenus.clear();
        }
        this.anchor = position;
        this.flight = undefined;
      } else if (this.flight?.sawPrompt) this.flight = undefined;
      const result: LegalAction[] = [];
      const nextCommands: Record<string, KeytekiCommand> = {};
      for (const entry of p.observation.legalActions) {
        const command = p.commands[entry.id];
        if (
          entry.action.kind === 'use' &&
          command.message === 'cardClicked' &&
          command.navigation &&
          command.intent === 'use' &&
          this.declinedUseMenus.has(entry.action.card)
        ) {
          p.unknown.push(
            'navigation-memory: declined complete Use menu is not reopened at this unchanged position',
          );
          continue;
        }
        if (
          entry.action.kind === 'activateProphecy' &&
          this.cancelledProphecies.has(canonical(entry.action))
        ) {
          p.unknown.push(
            'navigation-memory: cancelled prophecy route is not retried at this unchanged position',
          );
          continue;
        }
        const source = 'card' in entry.action ? entry.action.card : undefined;
        const menu = source ? this.menus.get(source) : undefined;
        if (command.message !== 'cardClicked' || !command.navigation || !source || !menu?.actions.length) {
          result.push(entry);
          nextCommands[entry.id] = command;
          continue;
        }
        const remaining = menu.actions.filter((a) => !menu.cancelled.has(route(a.action)!));
        for (const candidate of remaining) {
          const action = structuredClone(candidate.action),
            id = JSON.stringify(action);
          result.push({ ...structuredClone(candidate), id, action });
          nextCommands[id] = {
            ...structuredClone(command),
            navigation: true,
            intent: action.kind === 'discard' ? 'discard' : 'play',
          };
          if (
            action.kind === 'discard' &&
            (menu.cancelled.has('play') || menu.cancelled.has('play-as-upgrade'))
          ) {
            const receipt = canonical([this.anchor, source]);
            if (!this.exposed.has(receipt)) {
              this.exposed.add(receipt);
              this.count.discardRoutesExposed++;
            }
            p.unknown.push(
              `navigation-memory: cancelled ${menu.cancelled.has('play-as-upgrade') ? 'Play as upgrade' : 'Play'} route for ${source}; confirmed Discard remains available`,
            );
          }
        }
        if (!remaining.length)
          p.unknown.push(
            `navigation-memory: all observed routes for ${source} were cancelled at this unchanged position`,
          );
      }
      p.observation.legalActions = result;
      p.commands = nextCommands;
      p.navigationActionIds = result.filter((a) => nextCommands[a.id].navigation).map((a) => a.id);
    } else if (this.flight) {
      const flight = this.flight;
      flight.sawPrompt = true;
      if (flight.untouchedUseMenu) {
        const buttons = me?.buttons ?? [],
          uuid = buttons[0]?.uuid;
        // Only the complete, directly entered Card.use menu is eligible. A later
        // Fight target/effect prompt is not a decision to decline every use of
        // this card. Preserve all offered alternatives, including opaque Fight.
        const wholeMenu =
          me?.activePlayer === true &&
          me.menuTitle === 'Choose an ability:' &&
          me.selectCard === false &&
          me.selectOrder === false &&
          !p.unsupported.length &&
          p.observation.pending?.source === flight.source &&
          this.commandSourceCardId === flight.source &&
          !this.sourceBindingInvalidated &&
          buttons.length >= 2 &&
          typeof uuid === 'string' &&
          uuid.length > 0 &&
          buttons.filter((b) => b.text === 'Cancel').length === 1 &&
          buttons.every(
            (b) =>
              b.uuid === uuid && b.command === 'menuButton' && b.method === undefined && b.disabled !== true,
          ) &&
          p.observation.legalActions.length === buttons.length &&
          buttons.every((b) =>
            p.observation.legalActions.some((a) => {
              const command = p.commands[a.id];
              return (
                command.message === 'menuButton' &&
                command.sourceCardId === flight.source &&
                canonical(command.args) === canonical([b.arg, b.uuid])
              );
            }),
          );
        if (wholeMenu) declinedUseSource = flight.source;
        else flight.untouchedUseMenu = false;
      }
      const menuActions = p.observation.legalActions.filter((a) => {
        if (
          !route(a.action) ||
          !('card' in a.action) ||
          a.action.card !== flight.source ||
          p.commands[a.id]?.message !== 'menuButton'
        )
          return false;
        return (
          a.action.kind !== 'play' ||
          (a.action.target === undefined && a.action.flank === undefined && a.action.position === undefined)
        );
      });
      // Card.use() is a menu only when selectCard is false. A target/flank prompt can contain
      // semantically Play-like options but is not another independent card menu.
      if (me?.selectCard !== true && menuActions.length) {
        const previous = this.menus.get(flight.source);
        if (
          !previous ||
          canonical(previous.actions.map((a) => a.action)) !== canonical(menuActions.map((a) => a.action))
        )
          this.count.menusLearned++;
        const menu: MenuKnowledge = {
          actions: structuredClone(menuActions),
          cancelled: previous?.cancelled ?? new Set(),
        };
        this.menus.set(flight.source, menu);
        if (flight.requested) {
          const matching = menuActions.find((a) => sameAction(a.action, flight.requested!));
          if (matching && !menu.cancelled.has(route(matching.action)!)) {
            retain(p, [matching]);
            p.unknown.push('navigation-memory: continue the previously selected, still offered menu route');
          } else {
            flight.requested = undefined;
            p.unknown.push(
              'navigation-memory: server menu changed; choose again from its current offered routes',
            );
          }
        }
        if (!flight.requested && menu.cancelled.size)
          retain(
            p,
            p.observation.legalActions.filter((a) => !menu.cancelled.has(route(a.action)!)),
          );
      }
      if (me?.selectCard === true) {
        // Target prompts preserve the actual form chosen in the card menu.
        // Cancelling an attachment must not suppress an independently offered
        // creature play of the same physical card (for example PYR*0).
        const targetRoutes = new Set(
          p.observation.legalActions.flatMap(({ action }) =>
            action.kind === 'play' && action.card === flight.source && action.target !== undefined
              ? [route(action)!]
              : [],
          ),
        );
        if (targetRoutes.size === 1) flight.branch = [...targetRoutes][0];
      }
    }
    p.unknown = [...new Set(p.unknown)].sort();
    refreshFingerprint(p);
    const cancelIds = new Set<string>();
    for (const b of me?.buttons ?? []) {
      if (b.text !== 'Cancel') continue;
      for (const a of p.observation.legalActions) {
        const command = p.commands[a.id];
        if (
          a.action.kind === 'done' &&
          command.message === 'menuButton' &&
          canonical(command.args.slice(0, 2)) === canonical([b.arg ?? null, b.uuid])
        )
          cancelIds.add(a.id);
      }
    }
    const endTurnEntryId = isMain
      ? p.observation.legalActions.find((a) => {
          const command = p.commands[a.id];
          return (
            a.action.kind === 'endTurn' &&
            command.message === 'menuButton' &&
            (me?.buttons ?? []).some(
              (b) =>
                b.text === 'End Turn' &&
                b.arg === 'done' &&
                b.command === 'menuButton' &&
                b.method === undefined &&
                b.disabled !== true &&
                canonical(command.args) === canonical([b.arg, b.uuid]),
            )
          );
        })?.id
      : undefined;
    this.current = {
      prompt: prompt.signature,
      fingerprint: p.fingerprint,
      main: isMain,
      cancelIds,
      position,
      endTurnEntryId,
      endTurnConfirmationId,
      declinedUseSource,
    };
    return p;
  }
  /** Call exactly where the validated command is sent, not while merely considering a choice. */
  recordCommand(p: KeytekiProjection, actionId: string, command: KeytekiCommand): void {
    if (
      !this.current ||
      this.current.fingerprint !== p.fingerprint ||
      canonical(p.commands[actionId]) !== canonical(command)
    )
      throw Error('Stale navigation command');
    const a = p.observation.legalActions.find((a) => a.id === actionId)?.action;
    if (!a) throw Error('Unknown navigation choice');
    const key = canonical([p.fingerprint, actionId]);
    if (this.recorded.has(key)) return;
    this.recorded.add(key);
    // Cache only one known physical action at its actual offered Play menu. A
    // card-entry click, outer effect (e.g. Wild Wormhole), cancelled/discarded
    // route or any later command must never stand in for that executed choice.
    const continuingGift =
      this.resolvingPlayFlight?.source.definition === 'a-gift-of-æmber' &&
      this.resolvingPlayFlight.effectPrompt === this.current.prompt &&
      p.observation.pending?.source === this.resolvingPlayFlight.source.id &&
      p.observation.pending.min === 0 &&
      p.observation.pending.max === 2 &&
      p.observation.pending.intent?.kind === 'target-operation' &&
      p.observation.pending.intent.operation === 'destroy' &&
      a.kind === 'select' &&
      command.message === 'cardClicked' &&
      command.args[0] === a.target &&
      command.sourceCardId === this.resolvingPlayFlight.source.id;
    if (!continuingGift) this.resolvingPlayFlight = undefined;
    if (
      a.kind === 'play' &&
      a.asUpgrade !== true &&
      a.target === undefined &&
      a.flank === undefined &&
      a.position === undefined &&
      command.message === 'menuButton' &&
      command.intent === 'play' &&
      command.sourceCardId === a.card &&
      this.flight?.source === a.card &&
      !this.current.main &&
      p.observation.pending?.source === a.card &&
      !this.prophecyFlight &&
      !this.sourceBindingInvalidated
    ) {
      const source = p.observation.players[p.observation.you].hand?.find((c) => c.id === a.card);
      if (
        (source?.definition === 'they-tell-no-tales' ||
          source?.definition === 'divine-seal' ||
          source?.definition === 'a-gift-of-æmber') &&
        source.controller === p.observation.you &&
        !p.unknown.includes(`copy-text-unreported:${source.id}`)
      )
        this.resolvingPlayFlight = {
          source: {
            id: source.id,
            definition: source.definition,
            owner: source.owner,
            controller: source.controller,
            gameId: p.gameId,
            playerName: p.playerName,
            turn: p.observation.turn,
          },
          menuPrompt: this.current.prompt,
        };
    }
    if (actionId === this.current.endTurnEntryId) {
      this.endTurnFlight = { position: this.current.position };
    } else {
      if (actionId === this.current.endTurnConfirmationId) this.count.continuedRoutes++;
      this.endTurnFlight = undefined;
    }
    if (command.intent === 'prophecy') {
      if (a.kind === 'activateProphecy') {
        if (this.current.main && command.message === 'clickProphecy' && typeof command.args[0] === 'string') {
          this.prophecyFlight = {
            action: structuredClone(a),
            prophecyUuid: command.args[0],
            stage: 'confirm',
            sawPrompt: false,
          };
        } else if (
          this.prophecyFlight &&
          sameAction(this.prophecyFlight.action, a) &&
          command.message === 'menuButton'
        ) {
          this.prophecyFlight.stage = 'place';
          this.count.continuedRoutes++;
        } else if (
          this.prophecyFlight &&
          sameAction(this.prophecyFlight.action, a) &&
          command.message === 'cardClicked'
        ) {
          // Retain the route until a fresh view actually shows this entity under
          // the same physical slot. Sending is not proof of placement.
          this.count.continuedRoutes++;
        } else throw Error('Unbound prophecy navigation command');
      } else if (a.kind === 'done' && this.prophecyFlight && command.message === 'menuButton') {
        this.cancelledProphecies.add(canonical(this.prophecyFlight.action));
        this.prophecyFlight.cancelled = true;
        this.count.cancelledPaths++;
      } else throw Error('Unexpected prophecy navigation action');
      // A latent hand card is not the source of the prophecy's later Fate prompt.
      this.commandSourceCardId = undefined;
      this.lastClickedCardId = undefined;
      this.sourceBindingInvalidated = true;
      return;
    }
    if (
      command.message === 'menuButton' &&
      !command.sourceCardId &&
      p.unknown.some((reason) => reason.startsWith('card-ability-source-unresolved:'))
    ) {
      // An exact generic menu command can execute safely without knowing the physical
      // source. Do not let an older namesake binding reappear in its next target prompt.
      this.commandSourceCardId = undefined;
      this.sourceBindingInvalidated = true;
    } else if (command.sourceCardId) {
      this.commandSourceCardId = command.sourceCardId;
      this.sourceBindingInvalidated = false;
    }
    this.lastClickedCardId =
      command.message === 'cardClicked' && typeof command.args[0] === 'string' ? command.args[0] : undefined;
    if (this.current.main && command.message === 'cardClicked' && command.navigation && 'card' in a) {
      const known = this.menus.get(a.card);
      this.flight = {
        source: a.card,
        sawPrompt: false,
        untouchedUseMenu: a.kind === 'use' && command.intent === 'use',
        ...(known?.actions.some((item) => sameAction(item.action, a))
          ? { requested: structuredClone(a) }
          : {}),
      };
      return;
    }
    if (this.flight && command.message === 'menuButton') {
      if (
        this.current.declinedUseSource === this.flight.source &&
        this.current.cancelIds.has(actionId) &&
        !this.declinedUseMenus.has(this.flight.source)
      ) {
        this.declinedUseMenus.add(this.flight.source);
        this.count.cancelledPaths++;
      }
      // Once any branch was chosen, a later Cancel belongs to that branch.
      this.flight.untouchedUseMenu = false;
      const kind = route(a);
      if (kind && 'card' in a && a.card === this.flight.source) {
        this.flight.branch = kind;
        if (this.flight.requested) {
          this.count.continuedRoutes++;
          this.flight.requested = undefined;
        }
      }
      if (this.current.cancelIds.has(actionId) && this.flight.branch) {
        const menu = this.menus.get(this.flight.source),
          kind = this.flight.branch;
        if (menu && !menu.cancelled.has(kind)) {
          menu.cancelled.add(kind);
          this.count.cancelledPaths++;
        }
      }
    }
  }
}
