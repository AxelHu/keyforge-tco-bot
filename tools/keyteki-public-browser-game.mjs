/** Pure public-page binding helpers. No room setup, engine, browser launch or research runner. */

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const KEY_COLORS = ['red', 'blue', 'yellow'];

export function assertPublicBindingSource(source, { page, origin }) {
  if (!source || source.page !== page) throw Error('Bridge caller is not the configured player page');
  if (source.frame !== page.mainFrame()) throw Error('Bridge caller is not the player top frame');
  let actualOrigin;
  try {
    actualOrigin = new URL(source.frame.url()).origin;
  } catch {
    throw Error('Bridge caller has an unusable frame origin');
  }
  if (actualOrigin !== origin) throw Error('Bridge caller frame origin does not match the configured site');
  return true;
}

/** addInitScript runs in every frame: install settings only in the approved top document. */
export function publicTopFrameBootstrap(origin, bootstrapSource) {
  if (new URL(origin).origin !== origin || typeof bootstrapSource !== 'string')
    throw Error('Bootstrap requires an exact origin and a trusted script source');
  return (
    '(function(){if(window!==window.top||location.origin!==' +
    JSON.stringify(origin) +
    ')return;\n' +
    bootstrapSource +
    '\n})();'
  );
}

export function publicGameBinding({ origin, gameId, gameUrl }) {
  if (typeof gameId !== 'string' || !gameId || gameId.length > 150)
    throw Error('An explicit existing private game ID is required');
  const url = new URL(gameUrl);
  if (
    url.origin !== origin ||
    url.pathname !== '/play' ||
    url.searchParams.getAll('gameId').length !== 1 ||
    url.searchParams.get('gameId') !== gameId ||
    url.username ||
    url.password
  )
    throw Error('Game URL must bind the configured origin and gameId on /play');
  return { gameId, gameUrl: url.href };
}

export function publicGameFrameSummary(raw, { gameId, participants, playerName }) {
  if (!object(raw) || raw.id !== gameId) throw Error('Received a different public game identity');
  if (
    !object(raw.players) ||
    !sameNames(Object.keys(raw.players), participants) ||
    !participants.includes(playerName)
  )
    throw Error('Received players outside the configured two-account private game');
  for (const name of participants)
    if (raw.players[name]?.name && raw.players[name].name !== name)
      throw Error('Player-key and player-name bindings disagree');
  if (raw.winner != null && raw.winner !== '' && !participants.includes(raw.winner))
    throw Error('Winner does not identify a configured participant');
  const winner = participants.includes(raw.winner) ? raw.winner : null;
  return {
    gameId,
    playerName,
    started: raw.started === true,
    winner,
    players: Object.fromEntries(
      participants.map((name) => {
        const player = raw.players[name] ?? {},
          stats = player.stats ?? {};
        return [
          name,
          {
            keys: KEY_COLORS.filter((key) => stats.keys?.[key] === true),
            amber: typeof stats.amber === 'number' ? stats.amber : null,
            activePlayer: player.activePlayer === true,
            houses: Array.isArray(player.houses) ? [...player.houses] : [],
          },
        ];
      }),
    ),
  };
}
