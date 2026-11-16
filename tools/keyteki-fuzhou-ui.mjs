/** Observed Fuzhou UI setup for keyteki-public-browser-game.mjs.
 * One document and lobby connection per account: only the initial /login uses goto.
 * This module never sends a game/socket command itself and never records raw traffic.
 */
import { randomBytes } from 'node:crypto';

import { exactSiteOrigin } from './site-origin.mjs';
import { keytekiUiButton, keytekiUiName } from './keyteki-ui-contract.mjs';
const GAME_TYPES = new Set(['beginner', 'casual', 'competitive']);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const equalNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const EVENTS = new Set([
  'gamestate',
  'games',
  'newgame',
  'updategame',
  'removegame',
  'cleargamestate',
  'selectdeck',
]);

class UiFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new UiFailure(code);
};

/** Reject other packet names before parsing; authentication packets are never decoded here. */
export function fuzhouSocketEvent(payload) {
  if (typeof payload !== 'string') return null;
  const prefix = /^42\["([a-z]+)"(?:,|\])/.exec(payload);
  if (!prefix || !EVENTS.has(prefix[1])) return null;
  try {
    const packet = JSON.parse(payload.slice(2));
    return Array.isArray(packet) && packet[0] === prefix[1] ? packet : null;
  } catch {
    return null;
  }
}

export function fuzhouLoginReceipt(data, username, status) {
  if (status !== 200 || data?.success !== true || data?.user?.username !== username)
    fail('LOGIN_IDENTITY_NOT_CONFIRMED');
  return { username, status, responseIdentityConfirmed: true };
}

export function fuzhouDeckSpec(player) {
  const id = player.serverDeckId;
  if (
    !player.name ||
    typeof player.deckName !== 'string' ||
    !player.deckName.trim() ||
    !(
      (typeof id === 'number' && Number.isSafeInteger(id)) ||
      (typeof id === 'string' && /^[1-9][0-9]*$/.test(id))
    ) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) < 1
  )
    fail('DECK_BINDING_REQUIRED');
  return {
    player: player.name,
    serverDeckId: Number(id),
    deckName: player.deckName,
    ...(typeof player.deckSelector === 'string' ? { deckSelector: player.deckSelector } : {}),
  };
}

/** Select the creation form's radio, not the similarly named lobby filter.
 * The caller waits for the returned input to be checked before submitting the form.
 */
export async function fuzhouSelectGameType(page, gameType = 'casual') {
  if (!GAME_TYPES.has(gameType)) fail('GAME_TYPE_INVALID');
  const input = page.locator('input[type="radio"][name="gameType"][value="' + gameType + '"]');
  if ((await input.count()) !== 1) fail('GAME_TYPE_CONTROL_NOT_UNIQUE');
  if (!(await input.isChecked())) await input.locator('xpath=ancestor::label[1]').click();
  return input;
}

/** Full replacement, not a delta merge. Keep only our room's public preparation evidence. */
export function fuzhouPendingReceipt(
  raw,
  { playerName, participants, gameId, roomName, socketId, gameType = 'casual', allowSpectators = false },
) {
  if (!object(raw) || !object(raw.players) || typeof raw.id !== 'string') fail('PENDING_SHAPE');
  if ((gameId && raw.id !== gameId) || raw.name !== roomName) fail('PENDING_ROOM_MISMATCH');
  if (!GAME_TYPES.has(gameType) || raw.gameType !== gameType) fail('PENDING_GAME_TYPE_MISMATCH');
  const names = Object.keys(raw.players);
  if (!names.includes(playerName) || names.some((name) => !participants.includes(name)))
    fail('PENDING_PARTICIPANT_MISMATCH');
  if (
    raw.started !== false ||
    raw.gamePrivate !== true ||
    raw.needsPassword !== true ||
    typeof allowSpectators !== 'boolean' ||
    raw.allowSpectators !== allowSpectators
  )
    fail('PENDING_PRIVACY_MISMATCH');
  for (const name of names) if (raw.players[name]?.name !== name) fail('PENDING_PLAYER_NAME_MISMATCH');
  const ownId = raw.players[playerName].id;
  const socketIdentityConfirmed =
    typeof ownId === 'string' && typeof socketId === 'string' ? ownId === socketId : null;
  if (socketIdentityConfirmed === false) fail('PENDING_SOCKET_MISMATCH');
  return {
    gameId: raw.id,
    roomName,
    gameType: raw.gameType,
    playerName,
    started: false,
    gamePrivate: true,
    needsPassword: true,
    allowSpectators,
    socketIdentityConfirmed,
    players: Object.fromEntries(
      names.map((name) => [
        name,
        {
          name,
          selected: raw.players[name].deck?.selected === true,
          ...(name === playerName
            ? {
                deckName:
                  typeof raw.players[name].deck?.name === 'string' ? raw.players[name].deck.name : null,
              }
            : {}),
        },
      ]),
    ),
  };
}

export function fuzhouReadyReceipt({
  views,
  players,
  gameId,
  decks,
  gameType = 'casual',
  allowSpectators = false,
}) {
  if (!GAME_TYPES.has(gameType)) return { ready: false, reason: 'GAME_TYPE_INVALID' };
  const participants = players.map((player) => player.name);
  for (const player of players) {
    const view = views[player.name],
      deck = decks[player.name];
    if (
      !view ||
      view.playerName !== player.name ||
      view.gameId !== gameId ||
      view.started !== false ||
      view.gamePrivate !== true ||
      view.needsPassword !== true ||
      typeof allowSpectators !== 'boolean' ||
      view.allowSpectators !== allowSpectators ||
      !equalNames(Object.keys(view.players ?? {}), participants)
    )
      return { ready: false, reason: 'BOTH_CURRENT_PRIVATE_VIEWS_REQUIRED' };
    if (view.gameType !== gameType) return { ready: false, reason: 'BOTH_CURRENT_GAME_TYPES_REQUIRED' };
    if (participants.some((name) => view.players[name]?.selected !== true))
      return { ready: false, reason: 'BOTH_DECKS_NOT_SELECTED' };
    if (
      !deck ||
      deck.serverDeckId !== Number(player.serverDeckId) ||
      deck.deckName !== player.deckName ||
      deck.gameId !== gameId ||
      deck.commandObserved !== true ||
      !Number.isSafeInteger(view.sequence) ||
      !Number.isSafeInteger(deck.confirmedSequence) ||
      view.sequence < deck.confirmedSequence ||
      view.players[player.name].deckName !== player.deckName
    )
      return { ready: false, reason: 'DECK_SELECTION_NOT_CONFIRMED' };
  }
  return { ready: true };
}

export function fuzhouCleanupDisposition({ gameId, pending, startAttempted, activeObserved, result }) {
  if (!gameId) return 'no-room';
  if (result?.gameId === gameId && result.finished === true && result.participants?.includes(result.winner))
    return 'completed';
  if (!startAttempted && !activeObserved && pending?.gameId === gameId && pending.started === false)
    return 'pending';
  return 'active-or-unconfirmed';
}

function lobbyUrl(value, origin) {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin === origin && /^\/socket\.io\/?$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

/** Polling may carry the 40 connect ack before WebSocket upgrades. No raw packet is retained. */
export class FuzhouLobbyObserver {
  constructor(page, { origin, playerName }) {
    this.page = page;
    this.origin = origin;
    this.playerName = playerName;
    this.sequence = 0;
    this.commandSequence = 0;
    this.socketCount = 0;
    this.liveSockets = new Set();
    this.socketListeners = [];
    this.connected = false;
    this.disconnected = false;
    this.target = null;
    this.pending = null;
    this.listing = null;
    this.selection = null;
    this.error = null;
    this.activeObserved = false;
    this.existingGame = false;
    this.onSocket = (socket) => {
      if (!lobbyUrl(socket.url(), origin)) return;
      this.socketCount++;
      this.liveSockets.add(socket);
      if (this.socketCount > 1) this.error = 'MULTIPLE_LOBBY_CONNECTIONS';
      const receive = ({ payload }) => this.ingest(payload, 'websocket');
      const sent = ({ payload }) => this.ingest(payload, 'websocket-sent');
      const close = () => {
        this.liveSockets.delete(socket);
        this.disconnected = true;
      };
      socket.on('framereceived', receive);
      socket.on('framesent', sent);
      socket.on('close', close);
      this.socketListeners.push({ socket, receive, sent, close });
    };
    this.onResponse = async (response) => {
      const url = lobbyUrl(response.url(), origin);
      if (!url || url.searchParams.get('transport') !== 'polling' || response.request().method() !== 'GET')
        return;
      try {
        this.ingest(await response.text(), 'polling');
      } catch {
        /* A navigation may abort a poll. */
      }
    };
    page.on('websocket', this.onSocket);
    page.on('response', this.onResponse);
  }

  ingest(payload, transport) {
    const text =
      typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
    if (!text || text.length > 4 * 1024 * 1024) return;
    for (const part of text.split('\x1e')) {
      if (transport !== 'websocket-sent' && /^40(?:\{|$)/.test(part)) {
        this.connected = true;
        this.connectionEvidence ??= transport + ':40';
        try {
          const sid = JSON.parse(part.slice(2)).sid;
          if (typeof sid === 'string') {
            if (this.socketId && this.socketId !== sid) this.error = 'MULTIPLE_LOBBY_CONNECTIONS';
            this.socketId = sid;
          }
        } catch {
          /* Empty namespace acknowledgement. */
        }
        continue;
      }
      if (transport !== 'websocket-sent' && /^42\["(?:users|games|lobbymessages)"(?:,|\])/.test(part)) {
        this.connected = true;
        this.connectionEvidence ??= transport + ':public-event';
      }
      const event = fuzhouSocketEvent(part);
      if (!event) continue;
      if (transport === 'websocket-sent') {
        if (event[0] !== 'selectdeck' || !this.target?.gameId || event[1] !== this.target.gameId) continue;
        this.selection = {
          gameId: event[1],
          serverDeckId: event[2],
          isStandalone: event[3],
          sequence: ++this.commandSequence,
          observedAt: now(),
        };
        continue;
      }
      if (event[0] === 'cleargamestate') {
        this.pending = null;
        this.currentGameId = null;
        this.cleared = true;
        continue;
      }
      // The observed frontend receives an array of {id, ...} removals, never a scalar ID.
      if (event[0] === 'removegame') {
        if (
          this.target?.gameId &&
          Array.isArray(event[1]) &&
          event[1].some((game) => object(game) && game.id === this.target.gameId)
        ) {
          this.listing = null;
          this.pending = null;
          if (!this.activeObserved && this.currentGameId === this.target.gameId) this.currentGameId = null;
          this.cleared = true;
        }
        continue;
      }
      if (event[0] === 'gamestate') this.receivePending(event[1]);
      if (['games', 'newgame', 'updategame'].includes(event[0]) && this.target) {
        const candidates = event[1];
        if (!Array.isArray(candidates)) continue;
        for (const raw of candidates) {
          if (
            !object(raw) ||
            !object(raw.players) ||
            raw.name !== this.target.roomName ||
            (this.target.gameId && raw.id !== this.target.gameId)
          )
            continue;
          const names = Object.keys(raw.players);
          if (names.some((name) => !this.target.participants.includes(name))) {
            this.error = 'TARGET_LISTING_PARTICIPANT_MISMATCH';
            continue;
          }
          if (raw.started === true) {
            this.activeObserved = true;
            this.pending = null;
          }
          this.listing = {
            gameId: raw.id,
            started: raw.started === true,
            participants: names,
            observedAt: now(),
          };
        }
      }
    }
  }

  receivePending(raw) {
    if (!object(raw) || !object(raw.players)) return;
    if (Object.hasOwn(raw.players, this.playerName)) this.currentGameId = raw.id;
    if (!this.target) {
      if (Object.hasOwn(raw.players, this.playerName)) this.existingGame = true;
      return;
    }
    if (raw.name !== this.target.roomName || (this.target.gameId && raw.id !== this.target.gameId)) {
      if (Object.hasOwn(raw.players, this.playerName)) {
        this.error = 'UNEXPECTED_CURRENT_GAME';
        this.pending = null;
      }
      return;
    }
    if (raw.started === true) {
      this.activeObserved = true;
      this.pending = null;
      return;
    }
    // A delayed transport response cannot turn this same game back into a pending room.
    if (this.activeObserved) return;
    try {
      this.pending = {
        ...fuzhouPendingReceipt(raw, {
          ...this.target,
          playerName: this.playerName,
          socketId: this.socketId,
        }),
        sequence: ++this.sequence,
        observedAt: now(),
      };
      this.cleared = false;
    } catch (error) {
      this.error = error instanceof UiFailure ? error.code : 'INVALID_PENDING_STATE';
    }
  }

  assertHealthy() {
    if (this.error) fail(this.error);
    if (this.disconnected) fail('LOBBY_DISCONNECTED_DURING_SETUP');
  }

  dispose() {
    this.page.off('websocket', this.onSocket);
    this.page.off('response', this.onResponse);
    for (const { socket, receive, sent, close } of this.socketListeners) {
      socket.off('framereceived', receive);
      socket.off('framesent', sent);
      socket.off('close', close);
    }
  }
}

/** A factory gives each programmatic run its own setup state. Named exports below serve the CLI.
 * prepareMatch returns binding only after both current views confirm both selected decks.
 * cleanup attaches a secret-free uiSetup receipt to the runner's result before summary.json.
 */
export function createFuzhouUiSetup({
  origin: approvedOrigin,
  roomName,
  gameType = 'casual',
  allowSpectators = false,
  timeoutMs = 45000,
} = {}) {
  if (
    exactSiteOrigin(approvedOrigin) !== approvedOrigin ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000
  )
    fail('UI_OPTIONS_INVALID');
  if (roomName !== undefined && (typeof roomName !== 'string' || !roomName.trim() || roomName.length > 46))
    fail('ROOM_NAME_INVALID');
  if (!GAME_TYPES.has(gameType)) fail('GAME_TYPE_INVALID');
  if (typeof allowSpectators !== 'boolean') fail('SPECTATOR_SETTING_INVALID');
  const observers = new Map();
  const receipt = {
    schema: 'keyteki-fuzhou-ui-v1',
    origin: approvedOrigin,
    requestedGameType: gameType,
    requestedAllowSpectators: allowSpectators,
    identities: {},
    decks: {},
    pendingViews: {},
  };
  let phase = 'initial',
    binding,
    playersInMatch,
    startAttempted = false;
  const snapshot = () => structuredClone(receipt);
  const assertOrigin = (page, origin) => {
    if (origin !== approvedOrigin || new URL(page.url()).origin !== approvedOrigin)
      fail('UI_ORIGIN_MISMATCH');
  };
  const healthy = () => {
    for (const observer of observers.values()) observer.assertHealthy();
  };
  const waitUntil = async (check, code, checkHealth = true) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (checkHealth) healthy();
      const value = await check();
      if (value) return value;
      await pause(100);
    }
    fail(code);
  };
  const guarded = (callback) => async (args) => {
    try {
      return await callback(args);
    } catch (error) {
      const code = error instanceof UiFailure ? error.code : 'UI_OPERATION_FAILED';
      receipt.failure = {
        phase,
        code,
        at: now(),
        ...(phase.startsWith('login:') && receipt.preparePlayer
          ? {
              stage: receipt.preparePlayer.stage,
              errorKind:
                error instanceof UiFailure
                  ? 'condition'
                  : error?.name === 'TimeoutError'
                    ? 'timeout'
                    : 'operation',
              confirmed: { ...receipt.preparePlayer.confirmed },
            }
          : {}),
      };
      // Playwright error text can contain fill arguments. Never expose it or an error cause.
      throw new Error('Fuzhou UI failed at ' + phase + ': ' + code);
    }
  };
  const currentViews = () =>
    Object.fromEntries([...observers].map(([name, observer]) => [name, observer.pending]));
  const updateViews = () => {
    receipt.pendingViews = structuredClone(currentViews());
  };
  const ready = () => {
    healthy();
    return fuzhouReadyReceipt({
      views: currentViews(),
      players: playersInMatch,
      gameId: binding.gameId,
      decks: receipt.decks,
      gameType,
      allowSpectators,
    });
  };
  const setSwitch = async (page, id, text, checked) => {
    const input = page.locator('#' + id);
    if ((await input.isChecked()) !== checked) await page.getByText(text, { exact: true }).click();
    await waitUntil(async () => (await input.isChecked()) === checked, 'PRIVATE_ROOM_SWITCH_NOT_SET');
  };
  const selectDeck = async (page, player) => {
    phase = 'select-deck:' + player.name;
    const observer = observers.get(player.name),
      spec = fuzhouDeckSpec(player);
    const beforeState = observer.sequence,
      beforeCommand = observer.commandSequence;
    await page.getByRole('button', { name: 'Select deck', exact: true }).click();
    const ariaLabel = 'Select row ' + spec.serverDeckId;
    const row = page.getByRole('row').filter({
      has: page.getByRole('checkbox', { name: ariaLabel, exact: true }),
    });
    await row.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await row.count()) !== 1) fail('DECK_ROW_NOT_UNIQUE');
    await row.getByText(spec.deckName, { exact: true }).click();
    await waitUntil(() => {
      const command = observer.selection,
        pending = observer.pending;
      if (
        command &&
        command.sequence > beforeCommand &&
        (command.gameId !== binding.gameId ||
          command.serverDeckId !== spec.serverDeckId ||
          command.isStandalone !== false)
      )
        fail('DECK_COMMAND_BINDING_MISMATCH');
      return (
        command?.sequence > beforeCommand &&
        pending?.sequence > beforeState &&
        pending.gameId === binding.gameId &&
        pending.players[player.name]?.selected === true &&
        pending.players[player.name]?.deckName === spec.deckName
      );
    }, 'DECK_SELECTION_NOT_ACKNOWLEDGED');
    await page
      .getByRole('button', { name: 'Change deck', exact: true })
      .waitFor({ state: 'visible', timeout: timeoutMs });
    receipt.decks[player.name] = {
      ...spec,
      gameId: binding.gameId,
      rowAriaLabel: ariaLabel,
      commandObserved: true,
      isStandalone: false,
      confirmedSequence: observer.pending.sequence,
      ownSelected: true,
      ownDeckName: observer.pending.players[player.name].deckName,
      observedAt: observer.pending.observedAt,
    };
  };

  const preparePlayer = guarded(async ({ page, player, credentials, origin }) => {
    phase = 'login:' + player.name;
    receipt.preparePlayer = {
      stage: 'validate-configuration',
      confirmed: {
        initialLobbyConnected: false,
        responseIdentityConfirmed: false,
        rootRouteConfirmed: false,
        usernameButtonConfirmed: false,
        singleLobbySocketConfirmed: false,
      },
    };
    const stage = (value) => {
      receipt.preparePlayer.stage = value;
    };
    const confirmed = receipt.preparePlayer.confirmed;
    if (
      origin !== approvedOrigin ||
      credentials?.username !== player.name ||
      typeof credentials.password !== 'string' ||
      !credentials.password ||
      observers.has(player.name)
    )
      fail('LOGIN_CONFIGURATION_MISMATCH');
    fuzhouDeckSpec(player);
    stage('configure-page');
    await page.setViewportSize({ width: 1440, height: 1100 });
    page.setDefaultTimeout(timeoutMs);
    const observer = new FuzhouLobbyObserver(page, { origin, playerName: player.name });
    observers.set(player.name, observer);
    stage('navigate-login');
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    assertOrigin(page, origin);
    stage('wait-initial-lobby');
    await waitUntil(() => observer.connected, 'INITIAL_LOBBY_CONNECTION_NOT_READY');
    confirmed.initialLobbyConnected = true;
    stage('fill-credentials');
    await page.locator('input[name="username"]').fill(player.name);
    await page.locator('input[name="password"]').fill(credentials.password);
    stage('submit-login');
    const [response] = await Promise.all([
      page.waitForResponse(
        (value) => {
          const url = new URL(value.url());
          return (
            url.origin === origin &&
            url.pathname === '/api/account/login' &&
            value.request().method() === 'POST'
          );
        },
        { timeout: timeoutMs },
      ),
      page.locator('form button[type="submit"]').click(),
    ]);
    stage('verify-login-response');
    const login = fuzhouLoginReceipt(await response.json(), player.name, response.status());
    confirmed.responseIdentityConfirmed = true;
    stage('wait-root-route');
    // SPA route readiness must not wait for unrelated images or other unfinished load resources.
    // Authentication, the exact account button, and a single live lobby socket are checked separately.
    await page.waitForURL((url) => url.origin === origin && url.pathname === '/', {
      waitUntil: 'commit',
      timeout: timeoutMs,
    });
    confirmed.rootRouteConfirmed = true;
    stage('wait-username-button');
    // The default avatar contributes a '?' to the button's accessible name.
    // Bind the exact username descendant; login identity is verified above.
    await page
      .getByRole('button')
      .filter({ has: page.getByText(player.name, { exact: true }) })
      .waitFor({ state: 'visible', timeout: timeoutMs });
    confirmed.usernameButtonConfirmed = true;
    assertOrigin(page, origin);
    stage('wait-single-lobby-socket');
    await waitUntil(
      () => observer.socketCount === 1 && observer.liveSockets.size === 1,
      'LOBBY_WEBSOCKET_NOT_READY',
    );
    confirmed.singleLobbySocketConfirmed = true;
    receipt.identities[player.name] = {
      ...login,
      usernameButtonConfirmed: true,
      route: '/',
      connectionEvidence: observer.connectionEvidence,
      lobbySocketCount: observer.socketCount,
      observedAt: now(),
    };
    stage('complete');
  });

  // Only internally generated fields leave the setup boundary; never copy an Error or page data.
  const getPreparePlayerFailure = () => {
    const failure = receipt.failure;
    if (!failure?.stage) return null;
    return {
      stage: failure.stage,
      safeCode: failure.code,
      errorKind: failure.errorKind,
      at: failure.at,
      confirmed: { ...failure.confirmed },
    };
  };

  const prepareMatch = guarded(async ({ pages, players, origin, gameId, gameUrl, roomPassword }) => {
    phase = 'configure-private-room';
    if (gameId || gameUrl || binding) fail('NEW_PRIVATE_ROOM_REQUIRED');
    if (
      origin !== approvedOrigin ||
      !Array.isArray(players) ||
      players.length !== 2 ||
      new Set(players.map((player) => player.name)).size !== 2
    )
      fail('EXACT_PLAYER_PAIR_REQUIRED');
    playersInMatch = players.map((player) => ({ ...fuzhouDeckSpec(player), name: player.name }));
    const [host, guest] = playersInMatch,
      participants = playersInMatch.map((player) => player.name);
    for (const player of playersInMatch) {
      if (!receipt.identities[player.name] || !pages.has(player.name) || !observers.has(player.name))
        fail('PLAYER_NOT_PREPARED');
      assertOrigin(pages.get(player.name), origin);
      if (observers.get(player.name).existingGame) fail('ACCOUNT_ALREADY_IN_GAME');
    }
    const name = roomName ?? 'KF private ' + randomBytes(6).toString('hex');
    const password = roomPassword ?? randomBytes(24).toString('base64url');
    if (typeof password !== 'string' || !password) fail('ROOM_PASSWORD_REQUIRED');
    for (const observer of observers.values())
      observer.target = { roomName: name, participants, gameType, allowSpectators };
    const hostPage = pages.get(host.name),
      guestPage = pages.get(guest.name);
    const hostObserver = observers.get(host.name),
      guestObserver = observers.get(guest.name);
    phase = 'create-private-room';
    await hostPage.locator('a[href="/play"]:visible').click();
    await keytekiUiButton(hostPage, 'newGame').click();
    await hostPage.locator('#name').fill(name);
    const gameTypeInput = await fuzhouSelectGameType(hostPage, gameType);
    await waitUntil(() => gameTypeInput.isChecked(), 'GAME_TYPE_NOT_SELECTED');
    await setSwitch(hostPage, 'gamePrivate', 'Unlisted (link only)', true);
    await setSwitch(hostPage, 'allowSpectators', keytekiUiName('allowSpectators'), allowSpectators);
    await setSwitch(hostPage, 'requirePassword', 'Require password', true);
    await hostPage.locator('#password').fill(password);
    await keytekiUiButton(hostPage, 'start').click();
    await waitUntil(
      () => hostObserver.pending && equalNames(Object.keys(hostObserver.pending.players), [host.name]),
      'HOST_PRIVATE_ROOM_NOT_CONFIRMED',
    );
    binding = {
      gameId: hostObserver.pending.gameId,
      gameUrl: origin + '/play?gameId=' + encodeURIComponent(hostObserver.pending.gameId),
    };
    for (const observer of observers.values()) observer.target.gameId = binding.gameId;
    receipt.room = {
      ...binding,
      roomName: name,
      gameType: hostObserver.pending.gameType,
      allowSpectators: hostObserver.pending.allowSpectators,
      host: host.name,
      participants,
      createdAt: now(),
    };
    await selectDeck(hostPage, host);
    phase = 'wait-guest-target-listing';
    await waitUntil(
      () =>
        guestObserver.listing?.gameId === binding.gameId &&
        guestObserver.listing.started === false &&
        equalNames(guestObserver.listing.participants, [host.name]),
      'GUEST_TARGET_LISTING_NOT_JOINABLE',
    );
    receipt.guestJoinListing = structuredClone(guestObserver.listing);
    phase = 'join-private-room';
    // Observed normal React Router popstate path; no reload or private application API.
    await guestPage.evaluate((url) => {
      history.pushState(history.state, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, binding.gameUrl);
    assertOrigin(guestPage, origin);
    const passwordInput = guestPage.locator('input[type="password"]');
    await passwordInput.waitFor({ state: 'visible', timeout: timeoutMs });
    await passwordInput.fill(password);
    await keytekiUiButton(guestPage, 'join').click();
    await waitUntil(
      () =>
        [hostObserver, guestObserver].every(
          (observer) =>
            observer.pending?.gameId === binding.gameId &&
            equalNames(Object.keys(observer.pending.players), participants),
        ),
      'BOTH_PENDING_SEATS_NOT_CONFIRMED',
    );
    await selectDeck(guestPage, guest);
    phase = 'confirm-both-decks';
    await waitUntil(() => ready().ready, 'BOTH_DECKS_NOT_READY');
    const start = keytekiUiButton(hostPage, 'start');
    await waitUntil(
      async () => (await start.isVisible()) && (await start.isEnabled()),
      'HOST_START_NOT_ENABLED',
    );
    if (!ready().ready) fail('PENDING_CHANGED_BEFORE_BINDING');
    updateViews();
    receipt.room.hostStartEnabled = true;
    receipt.room.readyAt = now();
    return { ...binding, roomPassword: password, receipt: snapshot() };
  });

  const startMatch = guarded(async ({ pages, players, origin, gameId, gameUrl }) => {
    phase = 'start-bound-match';
    if (
      !binding ||
      origin !== approvedOrigin ||
      gameId !== binding.gameId ||
      gameUrl !== binding.gameUrl ||
      !equalNames(
        players.map((player) => player.name),
        playersInMatch.map((player) => player.name),
      )
    )
      fail('START_BINDING_MISMATCH');
    if (!ready().ready) fail('PENDING_CHANGED_BEFORE_START');
    const hostPage = pages.get(playersInMatch[0].name);
    assertOrigin(hostPage, origin);
    const start = keytekiUiButton(hostPage, 'start');
    if (!(await start.isEnabled())) fail('HOST_START_NOT_ENABLED');
    if (!ready().ready) fail('PENDING_CHANGED_BEFORE_START');
    updateViews();
    startAttempted = true;
    receipt.start = { gameId, requestedAt: now(), readyRechecked: true };
    await start.click();
    receipt.start.clickedAt = now();
  });

  const cleanup = async ({ pages, result }) => {
    receipt.cleanup = { players: {} };
    try {
      // Leave guest first; never concede or leave a failed/ambiguous active game.
      for (const player of [...(playersInMatch ?? [])].reverse()) {
        const observer = observers.get(player.name),
          page = pages.get(player.name);
        const disposition = fuzhouCleanupDisposition({
          gameId: binding?.gameId,
          pending: observer?.pending,
          startAttempted,
          activeObserved: observer?.activeObserved,
          result,
        });
        const entry = (receipt.cleanup.players[player.name] = { disposition });
        if (!['pending', 'completed'].includes(disposition) || !page || page.isClosed()) continue;
        if (observer?.currentGameId !== binding?.gameId) {
          entry.currentRoomUnconfirmed = true;
          continue;
        }
        try {
          assertOrigin(page, approvedOrigin);
          // The pending room and the finished board expose different normal leave controls.
          const leave = keytekiUiButton(page, disposition === 'completed' ? 'leaveFinished' : 'leavePending');
          if (!(await leave.isVisible())) {
            entry.controlUnavailable = true;
            continue;
          }
          await leave.click();
          entry.leaveClicked = true;
          await leave.waitFor({ state: 'hidden', timeout: timeoutMs });
          entry.leaveControlHidden = true;
        } catch {
          entry.uiLeaveFailed = true;
        }
      }
    } finally {
      for (const [name, observer] of observers) {
        if (receipt.identities[name]) receipt.identities[name].finalLobbySocketCount = observer.socketCount;
        observer.dispose();
      }
      receipt.cleanup.observedAt = now();
      result.uiSetup = snapshot();
    }
  };
  return { preparePlayer, prepareMatch, startMatch, cleanup, getReceipt: snapshot, getPreparePlayerFailure };
}

// Create an explicit-origin setup per account; importing this module performs no setup.
