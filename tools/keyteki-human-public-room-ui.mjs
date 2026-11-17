/** Draft single-seat preparation. Uses observed public lobby frames and existing normal UI controls. */
import { fuzhouSocketEvent, fuzhouDeckSpec, fuzhouSelectGameType } from './keyteki-fuzhou-ui.mjs';
import { fail } from './keyteki-human-config.mjs';
import { createJoinedPendingRoomTracker } from './keyteki-joined-pending-exit.mjs';
import { observePageDocuments } from './keyteki-document-observer.mjs';
import { keytekiUiButton, pendingLeaveFrameMatches } from './keyteki-ui-contract.mjs';
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const lobbyUrl = (value, origin) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin === origin && /^\/socket\.io\/?$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
};

export function publicPendingReceipt(raw, config, { listing = false, socketId = null } = {}) {
  if (!object(raw) || raw.id !== config.room.gameId || raw.name !== config.room.name || !object(raw.players))
    fail('PUBLIC_ROOM_BINDING_CHANGED');
  if (
    raw.started !== false ||
    raw.gamePrivate !== false ||
    raw.needsPassword !== false ||
    raw.gameType !== config.room.gameType ||
    raw.gameFormat !== config.room.gameFormat
  )
    fail('PUBLIC_ROOM_NOT_EXPECTED_JOINABLE_KIND');
  const names = Object.keys(raw.players);
  const expected = listing ? [config.room.opponentName] : config.participants;
  if (!same(names, expected) || names.some((name) => raw.players[name]?.name !== name))
    fail('PUBLIC_ROOM_PAIR_CHANGED');
  const self = raw.players[config.self.name];
  if (self && typeof self.id === 'string' && typeof socketId === 'string' && self.id !== socketId)
    fail('OWN_PENDING_SOCKET_MISMATCH');
  return {
    gameId: raw.id,
    roomName: raw.name,
    gameType: raw.gameType,
    gameFormat: raw.gameFormat,
    participants: names,
    started: false,
    public: true,
    requiresPassword: false,
    owner: typeof raw.owner === 'string' ? raw.owner : null,
    ownSelected: self?.deck?.selected === true,
    ownDeckName: typeof self?.deck?.name === 'string' ? self.deck.name : null,
    allSelected: !listing && names.every((name) => raw.players[name]?.deck?.selected === true),
    observedAt: Date.now(),
  };
}

export function createdPublicPendingReceipt(
  raw,
  config,
  { gameId = null, opponentName = null, socketId = null } = {},
) {
  if (
    !config.createPublic ||
    !object(raw) ||
    typeof raw.id !== 'string' ||
    !raw.id ||
    (gameId && raw.id !== gameId) ||
    raw.name !== config.room.name ||
    !object(raw.players) ||
    raw.owner !== config.self.name
  )
    fail('CREATED_PUBLIC_ROOM_BINDING_CHANGED');
  const names = Object.keys(raw.players),
    others = names.filter((name) => name !== config.self.name);
  if (
    !names.includes(config.self.name) ||
    names.length > 2 ||
    names.some((name) => raw.players[name]?.name !== name) ||
    others.some((name) => config.ownAccountNames.includes(name)) ||
    (opponentName && !same(others, [opponentName]))
  )
    fail('CREATED_PUBLIC_ROOM_PAIR_CHANGED');
  const bound = { ...config, room: { ...config.room, gameId: raw.id }, participants: names };
  return {
    ...publicPendingReceipt(raw, bound, { socketId }),
    owner: config.self.name,
    allSelected: names.length === 2 && names.every((name) => raw.players[name]?.deck?.selected === true),
  };
}

export class PublicRoomObserver {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.listing = null;
    this.pending = null;
    this.selection = null;
    this.sequence = 0;
    this.commandSequence = 0;
    this.error = null;
    this.socketId = null;
    this.listeners = [];
    this.joinRequested = false;
    this.active = false;
    this.creationRequested = false;
    this.createdGameId = null;
    this.candidateName = null;
    this.leaveRequested = false;
    this.pendingLeave = null;
    this.serverLeaveReceipt = null;
    this.cleared = false;
    this.anyOtherSeatObserved = false;
    this.documentEpoch = 0;
    this.nativeSocketNumber = 0;
    this.nativeRequestNumber = 0;
    this.requestEpochs = new WeakMap();
    this.joinedPending = config.createPublic ? null : createJoinedPendingRoomTracker(config);
    this.createdPending = config.createPublic ? createJoinedPendingRoomTracker(config, { created: true }) : null;
    this.pendingTracker = this.joinedPending ?? this.createdPending;
    this.onRequest = (request) => {
      const url = lobbyUrl(request.url(), config.origin);
      if (!url || url.searchParams.get('transport') !== 'polling') return;
      const metadata = {
        documentEpoch: this.documentEpoch,
        transportKey: url.searchParams.get('sid') ?? 'polling-unbound',
        transportKind: 'polling',
        requestId: 'request-' + ++this.nativeRequestNumber,
        method: request.method(),
      };
      this.requestEpochs.set(request, metadata);
      this.pendingTracker?.observeTransport('request-start', metadata);
      if (request.method() === 'POST')
        this.ingest(request.postData() ?? '', true, metadata);
    };
    this.onRequestFailed = (request) => {
      const metadata = this.requestEpochs.get(request);
      if (metadata) this.pendingTracker?.observeTransport('request-failed', metadata);
    };
    this.onSocket = (socket) => {
      const url = lobbyUrl(socket.url(), config.origin);
      if (!url) return;
      const channelId = 'websocket-' + ++this.nativeSocketNumber;
      const metadata = {
        documentEpoch: this.documentEpoch,
        transportKey: url.searchParams.get('sid') ?? channelId,
        transportKind: 'websocket',
        channelId,
      };
      this.pendingTracker?.observeTransport('socket-open', metadata);
      const received = ({ payload }) => this.ingest(payload, false, metadata);
      const sent = ({ payload }) => this.ingest(payload, true, metadata);
      const closed = () => this.pendingTracker?.observeTransport('socket-close', metadata);
      const errored = () => this.pendingTracker?.observeTransport('socket-error', metadata);
      socket.on('framereceived', received);
      socket.on('framesent', sent);
      socket.on('close', closed);
      socket.on('socketerror', errored);
      this.listeners.push({ socket, received, sent, closed, errored });
    };
    this.onResponse = async (response) => {
      const url = lobbyUrl(response.url(), config.origin);
      if (!url || url.searchParams.get('transport') !== 'polling') return;
      const request = response.request();
      const metadata = this.requestEpochs.get(request) ?? {
        documentEpoch: this.documentEpoch,
        transportKey: url.searchParams.get('sid') ?? 'polling-unbound',
        transportKind: 'polling',
        requestId: null,
        method: request.method(),
      };
      try {
        const status = response.status?.();
        if (Number.isInteger(status) && (status < 200 || status >= 400))
          this.pendingTracker?.observeTransport('request-failed', metadata);
        if (request.method() === 'GET') this.ingest(await response.text(), false, metadata);
        this.pendingTracker?.observeTransport('request-complete', metadata);
      } catch {
        this.pendingTracker?.observeTransport('request-failed', metadata);
        /* The legacy preparation observer still waits for later native readiness. */
      }
    };
    page.on('request', this.onRequest);
    page.on('requestfailed', this.onRequestFailed);
    page.on('websocket', this.onSocket);
    page.on('response', this.onResponse);
    this.documentMonitor = observePageDocuments(page, {
      onDocument: () => this.pendingTracker?.documentChanged(++this.documentEpoch),
      onUnavailable: code => this.pendingTracker?.documentObservationLost({ closed: code === 'PENDING_DOCUMENT_OBSERVER_CLOSED' }),
      timeoutMs: config.setupTimeoutMs,
    });
    this.ready = this.documentMonitor.ready.then(() => this);
    this.ready.catch(() => {});
  }
  get documentReady() { return this.documentMonitor.snapshot().ready; }
  get documentIdentity() { return this.documentMonitor.snapshot().identity; }
  ingest(payload, sent = false, metadata = {}) {
    this.pendingTracker?.ingest(payload, { ...metadata, sent, joinRequested: this.joinRequested,
      creationRequested: this.creationRequested });
    const text =
      typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
    if (!text || text.length > 4 * 1024 * 1024) return;
    for (const part of text.split('\x1e')) {
      if (!sent && /^40\{/.test(part)) {
        try {
          const sid = JSON.parse(part.slice(2)).sid;
          if (typeof sid === 'string') this.socketId = sid;
        } catch {}
        continue;
      }
      // Both observed pending-room Leave shapes remain bound to the exact pending room.
      const event =
        sent && pendingLeaveFrameMatches(part, this.pendingLeave?.gameId)
          ? ['leavegame']
          : fuzhouSocketEvent(part);
      if (!event) continue; // Never decode authentication or handoff packets.
      if (sent) {
        if (
          event[0] === 'leavegame' &&
          this.pendingLeave &&
          this.pending?.gameId === this.pendingLeave.gameId &&
          this.pending?.owner === this.config.self.name &&
          same(this.pending.participants, [this.config.self.name]) &&
          !this.active &&
          !this.anyOtherSeatObserved &&
          !this.candidateName
        ) {
          this.pendingLeave.sequence = this.pending.sequence;
          this.pendingLeave.commandObserved = true;
        }
        if (event[0] === 'selectdeck' && event[1] === (this.config.room.gameId ?? this.createdGameId))
          this.selection = {
            gameId: event[1],
            serverDeckId: event[2],
            isStandalone: event[3],
            sequence: ++this.commandSequence,
          };
        continue;
      }
      try {
        if (['games', 'newgame', 'updategame'].includes(event[0]) && Array.isArray(event[1])) {
          const target = event[1].find((row) => row?.id === (this.config.room.gameId ?? this.createdGameId));
          if (!target) {
            if (event[0] === 'games') this.listing = null;
            continue;
          }
          if (target.started === true) {
            this.active = true;
            this.listing = null;
            continue;
          }
          if (
            this.config.createPublic &&
            Object.keys(target.players ?? {}).some((name) => name !== this.config.self.name)
          )
            this.anyOtherSeatObserved = true;
          if (this.active || this.config.createPublic) continue;
          if (!this.joinRequested)
            this.listing = publicPendingReceipt(target, this.config, { listing: true });
          // A lobby listing may lag our native pending view by one broadcast.
          else if (Object.keys(target.players ?? {}).some((name) => !this.config.participants.includes(name)))
            fail('PUBLIC_ROOM_PAIR_CHANGED');
        }
        if (
          event[0] === 'removegame' &&
          Array.isArray(event[1]) &&
          event[1].some((x) => x?.id === (this.config.room.gameId ?? this.createdGameId))
        ) {
          this.listing = null;
          if (this.pendingLeave?.commandObserved && this.pendingLeave.gameId === this.createdGameId)
            this.serverLeaveReceipt = {
              gameId: this.pendingLeave.gameId,
              source: 'removegame',
              ownPendingSequence: this.pendingLeave.sequence,
              nativeLeaveObserved: true,
            };
        }
        if (event[0] === 'cleargamestate') {
          if (this.pendingLeave?.commandObserved && this.pendingLeave.gameId === this.createdGameId)
            this.serverLeaveReceipt = {
              gameId: this.pendingLeave.gameId,
              source: 'cleargamestate',
              ownPendingSequence: this.pendingLeave.sequence,
              nativeLeaveObserved: true,
            };
          this.cleared = true;
          this.pending = null;
        }
        if (event[0] === 'gamestate' && object(event[1]?.players)) {
          const raw = event[1];
          if (this.config.createPublic) {
            if (!Object.hasOwn(raw.players, this.config.self.name)) continue;
            if (!this.creationRequested) fail('ACCOUNT_ALREADY_IN_GAME');
            if (raw.started === true || this.active) {
              this.active = true;
              fail('UNEXPECTED_ROOM_STARTED_BEFORE_PAIR_LOCK');
            }
            const receipt = createdPublicPendingReceipt(raw, this.config, {
              gameId: this.createdGameId,
              opponentName: this.candidateName,
              socketId: this.socketId,
            });
            this.createdGameId ??= receipt.gameId;
            this.candidateName ??=
              receipt.participants.find((name) => name !== this.config.self.name) ?? null;
            this.anyOtherSeatObserved ||= Boolean(this.candidateName);
            this.pending = { ...receipt, sequence: ++this.sequence };
            // A later native own-seat state supersedes any earlier departure acknowledgement.
            if (this.pendingLeave) this.serverLeaveReceipt = null;
            this.cleared = false;
            continue;
          }
          if (Object.hasOwn(raw.players, this.config.self.name) && raw.id !== this.config.room.gameId)
            fail('ACCOUNT_IN_DIFFERENT_GAME');
          if (raw.id !== this.config.room.gameId) continue;
          if (!this.joinRequested && Object.hasOwn(raw.players, this.config.self.name))
            fail('ACCOUNT_ALREADY_IN_TARGET_GAME');
          if (raw.started === true) {
            this.active = true;
            continue;
          }
          if (this.active) continue;
          if (this.creationRequested && raw.owner !== this.config.self.name)
            fail('CREATED_PUBLIC_HOST_CHANGED');
          this.pending = {
            ...publicPendingReceipt(raw, this.config, { socketId: this.socketId }),
            sequence: ++this.sequence,
          };
        }
      } catch (error) {
        this.error = /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'PUBLIC_LOBBY_SHAPE_UNVERIFIED';
      }
    }
  }
  assertHealthy() {
    if (this.error) fail(this.error);
    this.documentMonitor.assertReady();
  }
  assertJoinable() {
    this.assertHealthy();
    if (!this.listing || this.active) fail('CURRENT_PUBLIC_LISTING_REQUIRED');
  }
  assertEmptyOwned() {
    this.assertHealthy();
    if (
      !this.config.createPublic ||
      !this.createdGameId ||
      this.active ||
      this.candidateName ||
      this.anyOtherSeatObserved ||
      this.pending?.gameId !== this.createdGameId ||
      this.pending.owner !== this.config.self.name ||
      !same(this.pending.participants, [this.config.self.name])
    )
      fail('ONLY_UNJOINED_OWN_PENDING_ROOM_MAY_CLOSE');
  }
  dispose() {
    this.page.off('request', this.onRequest);
    this.page.off('requestfailed', this.onRequestFailed);
    this.page.off('websocket', this.onSocket);
    this.page.off('response', this.onResponse);
    for (const { socket, received, sent, closed, errored } of this.listeners) {
      socket.off('framereceived', received);
      socket.off('framesent', sent);
      socket.off('close', closed);
      socket.off('socketerror', errored);
    }
    return this.documentMonitor.dispose();
  }
}

export async function waitForObserved(check, timeoutMs, code, health = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    health();
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(code);
}

/** The captured frontend implements /play?gameId through this normal SPA path.
 * It can otherwise choose Watch for full/started rooms; native pending/full receipts remain mandatory.
 */
export async function joinObservedPublicRoom(page, observer, config) {
  observer.assertJoinable();
  if (new URL(page.url()).origin !== config.origin) fail('UI_ORIGIN_CHANGED');
  observer.joinRequested = true;
  await page.evaluate((url) => {
    history.pushState(history.state, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, config.gameUrl);
  await waitForObserved(
    () => observer.pending,
    config.setupTimeoutMs,
    'OWN_PUBLIC_SEAT_NOT_CONFIRMED',
    () => observer.assertHealthy(),
  );
  return observer.pending;
}

/** Short UI sequence from the existing, observed helper (its private selectDeck closure is not exported).
 * No socket command is emitted here: the normal Select deck UI is the sole selection action.
 */
export async function selectOwnDeckUi(page, observer, config, firstFullVerified = () => false) {
  const spec = fuzhouDeckSpec(config.self),
    before = observer.commandSequence;
  if (new URL(page.url()).origin !== config.origin || !observer.pending) fail('OWN_PENDING_SEAT_REQUIRED');
  await page.getByRole('button', { name: 'Select deck', exact: true }).click();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: 'Select row ' + spec.serverDeckId, exact: true }) });
  await row.waitFor({ state: 'visible', timeout: config.setupTimeoutMs });
  if ((await row.count()) !== 1) fail('OWN_DECK_ROW_NOT_UNIQUE');
  await row.getByText(spec.deckName, { exact: true }).click();
  await waitForObserved(
    () => {
      const selected = observer.selection;
      if (!selected || selected.sequence <= before) return false;
      if (
        selected.gameId !== (config.room.gameId ?? observer.createdGameId) ||
        Number(selected.serverDeckId) !== spec.serverDeckId ||
        selected.isStandalone !== false
      )
        fail('OWN_DECK_COMMAND_MISMATCH');
      // A fast human host can start before our final pending update arrives. A separately verified
      // native full state with our exact selected deck also proves this UI selection reached the game.
      return (
        (observer.pending?.ownSelected && observer.pending.ownDeckName === spec.deckName) ||
        firstFullVerified()
      );
    },
    config.setupTimeoutMs,
    'OWN_DECK_SELECTION_NOT_CONFIRMED',
    () => observer.assertHealthy(),
  );
  return { serverDeckId: spec.serverDeckId, deckName: spec.deckName, commandObserved: true };
}

/** Same observed New game form as the existing helper, with public/no-password values. */
export async function createPublicRoomUi(page, observer, config) {
  observer.assertHealthy();
  if (
    !config.createPublic ||
    !['beginner', 'casual'].includes(config.room?.gameType) ||
    observer.pending ||
    observer.createdGameId ||
    new URL(page.url()).origin !== config.origin
  )
    fail('PUBLIC_CREATION_PRECONDITION');
  await page.locator('a[href="/play"]:visible').click();
  await keytekiUiButton(page, 'newGame').click();
  await page.locator('#name').fill(config.room.name);
  const gameType = await fuzhouSelectGameType(page, config.room.gameType);
  await waitForObserved(
    () => gameType.isChecked(),
    config.setupTimeoutMs,
    config.room.gameType.toUpperCase() + '_NOT_SELECTED',
  );
  const normal = page.locator('input[type="radio"][name="gameFormat"][value="normal"]');
  if ((await normal.count()) !== 1) fail('NORMAL_FORMAT_CONTROL_UNVERIFIED');
  if (!(await normal.isChecked())) await normal.locator('xpath=ancestor::label[1]').click();
  await waitForObserved(() => normal.isChecked(), config.setupTimeoutMs, 'NORMAL_FORMAT_NOT_SELECTED');
  for (const [id, label, checked] of [
    ['gamePrivate', 'Unlisted (link only)', false],
    ['requirePassword', 'Require password', false],
  ]) {
    const input = page.locator('#' + id);
    if ((await input.isChecked()) !== checked) await page.getByText(label, { exact: true }).click();
    await waitForObserved(
      async () => (await input.isChecked()) === checked,
      config.setupTimeoutMs,
      'PUBLIC_ROOM_SWITCH_UNVERIFIED',
    );
  }
  observer.assertHealthy();
  observer.creationRequested = true;
  await keytekiUiButton(page, 'start').click();
  await waitForObserved(
    () => observer.pending,
    config.setupTimeoutMs,
    'CREATED_PUBLIC_ROOM_NOT_CONFIRMED',
    () => observer.assertHealthy(),
  );
  return observer.pending;
}

export async function leaveUnjoinedOwnRoomUi(page, observer, config) {
  const deadline = Date.now() + config.setupTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  observer.assertEmptyOwned();
  if (new URL(page.url()).origin !== config.origin) fail('UI_ORIGIN_CHANGED');
  const leave = keytekiUiButton(page, 'leavePending');
  await leave.waitFor({ state: 'visible', timeout: remaining() });
  observer.assertEmptyOwned();
  if (observer.leaveRequested) fail('EMPTY_ROOM_LEAVE_ALREADY_ATTEMPTED');
  observer.leaveRequested = true;
  observer.serverLeaveReceipt = null;
  observer.pendingLeave = {
    gameId: observer.createdGameId,
    sequence: observer.pending.sequence,
    commandObserved: false,
  };
  await leave.click({ timeout: remaining() });
  await leave.waitFor({ state: 'hidden', timeout: remaining() });
  const healthy = () => {
    observer.assertHealthy();
    if (new URL(page.url()).origin !== config.origin) fail('UI_ORIGIN_CHANGED');
    if (observer.candidateName || observer.anyOtherSeatObserved || observer.active)
      fail('OPPONENT_ARRIVED_DURING_EMPTY_ROOM_LEAVE');
  };
  const receipt = await waitForObserved(
    () => observer.serverLeaveReceipt?.gameId === observer.createdGameId && observer.serverLeaveReceipt,
    remaining(),
    'EMPTY_ROOM_SERVER_LEAVE_UNCONFIRMED',
    healthy,
  );
  healthy();
  return {
    gameId: observer.createdGameId,
    noOpponentObserved: true,
    normalUiLeaveConfirmed: true,
    serverLeaveConfirmed: true,
    serverLeaveReceipt: receipt,
  };
}

export async function startOwnBoundRoomUi(page, observer, config) {
  const ready = () => {
    observer.assertHealthy();
    return (
      !observer.active &&
      observer.pending?.gameId === config.room.gameId &&
      observer.pending.owner === config.self.name &&
      same(observer.pending.participants, config.participants) &&
      observer.pending.allSelected &&
      observer.pending.ownSelected &&
      observer.pending.ownDeckName === config.self.deckName
    );
  };
  await waitForObserved(ready, config.setupTimeoutMs, 'HUMAN_DECK_NOT_READY');
  const start = keytekiUiButton(page, 'start');
  if (!(await start.isVisible()) || !(await start.isEnabled()) || !ready())
    fail('BOUND_HOST_START_NOT_READY');
  await start.click();
  return { gameId: config.room.gameId, clicked: true, participants: config.participants };
}
