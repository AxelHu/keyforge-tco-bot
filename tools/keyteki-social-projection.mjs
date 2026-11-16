/** Strict projection of native Keyteki public table chat; never forwards raw player state. */
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export function nativeKeytekiChat(raw, participants) {
  if (!Array.isArray(raw?.messages)) return [];
  return raw.messages.slice(-150).flatMap((row) => {
    const parts = row?.message;
    // The real formatter drops empty literal fragments: [player, ' ', text].
    // Rules messages use nonAvatarPlayer and/or activePlayer, not this shape.
    if (
      !object(row) ||
      Object.hasOwn(row, 'activePlayer') ||
      typeof row.id !== 'string' ||
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts[1] !== ' ' ||
      !object(parts[0]) ||
      parts[0].argType !== 'player' ||
      !participants.includes(parts[0].name) ||
      typeof parts[2] !== 'string'
    )
      return [];
    const atMs = Date.parse(row.date);
    if (!Number.isFinite(atMs)) return [];
    return [{ id: row.id, author: parts[0].name, text: parts[2].slice(0, 512), atMs }];
  });
}

function seat(player) {
  const stats = object(player?.stats) ? player.stats : {};
  const keys = object(stats.keys) ? stats.keys : null;
  const creatures = Array.isArray(player?.cardPiles?.cardsInPlay)
    ? player.cardPiles.cardsInPlay.filter((card) => card?.type === 'creature')
    : null;
  return {
    keys: keys ? ['red', 'blue', 'yellow'].filter((key) => keys[key] === true).length : null,
    amber: count(stats.amber),
    keyCost: count(stats.keyCost),
    creatures: creatures?.length ?? null,
    readyCreatures: creatures?.filter((card) => card.exhausted === false).length ?? null,
    deckName: typeof player?.deckData?.name === 'string' ? player.deckData.name : '',
  };
}

export function keytekiSocialSnapshot(session, binding, ready) {
  const raw = session.latestRaw;
  if (!raw || raw.id !== binding.gameId || !object(raw.players)) throw Error('Social game unavailable');
  const names = Object.keys(raw.players);
  if (names.length !== 2 || !names.includes(binding.playerName) || !names.includes(binding.opponentName))
    throw Error('Social participants changed');
  const history = session.stream.history.snapshot();
  const winner = typeof raw.winner === 'string' ? raw.winner : raw.winner?.name;
  return {
    ...binding,
    revision: session.revision,
    // Unknown history is not reconstructed as a made-up turn ordinal.
    turn: history.currentTurn ?? history.observedEndTurns,
    started: raw.started === true,
    finished: Boolean(winner),
    winnerName: winner ?? null,
    ready: ready === true && raw.manualMode !== true,
    self: {
      ...seat(raw.players[binding.playerName]),
      ...(raw.hideDeckLists === true ? { deckName: '' } : {}),
    },
    opponent: {
      ...seat(raw.players[binding.opponentName]),
      ...(raw.hideDeckLists === true || raw.gameFormat === 'sealed' ? { deckName: '' } : {}),
    },
    recentChat: nativeKeytekiChat(raw, names),
  };
}
