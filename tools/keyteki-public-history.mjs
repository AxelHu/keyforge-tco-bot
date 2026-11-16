/** Public log observations only. Card text and referee-private turn state are never inputs. */
export function keytekiEndTurnEvent(message) {
  const alert = message?.message?.alert;
  if (alert?.type !== 'endofturn' || !Array.isArray(alert.message) || alert.message.length !== 1) return null;
  const text = alert.message[0];
  if (typeof text !== 'string') return null;
  const match = /^(?:End of turn ([1-9]\d*)|回合 ([1-9]\d*) 结束)$/.exec(text);
  if (!match) return null;
  const round = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(round)) return null;
  // Both players can end the same numbered round, including extra turns. Text/round is not identity.
  return { id: typeof message.id === 'string' && message.id.length ? message.id : null, round };
}

export class KeytekiPublicHistory {
  constructor() {
    this.gameId = undefined;
    this.seenStarted = false;
    this.startObserved = false;
    this.firstPlayerName = undefined;
    this.endTurns = new Map();
    this.previousWindow = new Set();
    this.unknownReasons = new Set(['start-of-game-unobserved']);
  }
  invalidate(reason) {
    this.unknownReasons.add(reason);
  }
  observe(raw) {
    if (this.gameId && this.gameId !== raw.id) {
      this.invalidate('game-identity-changed');
      return this.snapshot();
    }
    this.gameId ??= raw.id;
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const events = messages.map(keytekiEndTurnEvent).filter(Boolean);
    const players = Object.values(raw.players ?? {});
    const setup = players.length === 2 && players.every((p) => p.phase === 'setup');
    // A mid-game reconnect with old messages must not reconstruct its unseen prefix as zero.
    if (!this.seenStarted && raw.started === true && setup && Array.isArray(raw.messages) && !events.length) {
      this.startObserved = true;
      this.unknownReasons.delete('start-of-game-unobserved');
    }
    if (raw.started === true) this.seenStarted = true;
    if (this.seenStarted && !Array.isArray(raw.messages)) this.invalidate('message-window-unreported');
    const window = new Set(messages.map((m) => m?.id).filter((id) => typeof id === 'string' && id.length));
    if (this.previousWindow.size && ![...window].some((id) => this.previousWindow.has(id)))
      this.invalidate('message-window-continuity-unknown');
    this.previousWindow = window;
    for (const event of events) {
      if (event.id === null) {
        this.invalidate('end-turn-message-without-id');
        continue;
      }
      const old = this.endTurns.get(event.id);
      if (old !== undefined && old !== event.round) this.invalidate('end-turn-message-id-reused');
      else this.endTurns.set(event.id, event.round);
    }
    for (const message of messages) {
      if (this.endTurns.has(message?.id) && !keytekiEndTurnEvent(message))
        this.invalidate('end-turn-message-id-reused');
    }
    if (this.startObserved && !this.firstPlayerName && !this.endTurns.size)
      this.firstPlayerName = players.find((p) => p.activePlayer === true)?.name;
    return this.snapshot();
  }
  snapshot() {
    const fromGameStart = this.startObserved && this.unknownReasons.size === 0;
    return {
      currentTurn: fromGameStart ? this.endTurns.size + 1 : null,
      observedEndTurns: this.endTurns.size,
      fromGameStart,
      firstPlayerName: this.firstPlayerName,
      unknownReasons: [...this.unknownReasons].sort(),
    };
  }
}
