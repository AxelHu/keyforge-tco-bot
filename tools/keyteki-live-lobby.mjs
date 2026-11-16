/** Read-only native lobby discovery. Never decodes auth packets or sends lobby/game commands. */
import path from 'node:path';
import { fuzhouSocketEvent } from './keyteki-fuzhou-ui.mjs';
import { exactSiteOrigin } from './site-origin.mjs';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (x, max = 160) =>
  typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
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

export function publicLobbyRow(raw, observedAt) {
  if (!object(raw) || !text(raw.id, 100) || !object(raw.players)) return null;
  const names = Object.keys(raw.players);
  if (names.length > 2 || names.some((name) => !text(name) || raw.players[name]?.name !== name)) return null;
  return {
    id: raw.id,
    // The server can list a running room without a display name. Keep its membership
    // in the complete roster; the planner still rejects a room with no usable name.
    name: text(raw.name, 100) ? raw.name : null,
    owner: text(raw.owner) ? raw.owner : null,
    ...Object.fromEntries(
      ['started', 'gamePrivate', 'needsPassword', 'joinable', 'canJoin']
        .filter((key) => typeof raw[key] === 'boolean')
        .map((key) => [key, raw[key]]),
    ),
    gameType: text(raw.gameType, 40) ? raw.gameType : null,
    gameFormat: text(raw.gameFormat, 40) ? raw.gameFormat : null,
    players: Object.fromEntries(
      names.map((name) => [
        name,
        {
          name,
          ...Object.fromEntries(
            ['left', 'disconnected']
              .filter((key) => typeof raw.players[name][key] === 'boolean')
              .map((key) => [key, raw.players[name][key]]),
          ),
        },
      ]),
    ),
    observedAt,
  };
}

export function createNativeLobbyRoster({ now = Date.now } = {}) {
  let rooms = new Map(),
    fullObservedAt = null,
    observedAt = null,
    ordinal = 0;
  return {
    ingest(payload) {
      const value =
        typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
      if (!value || value.length > 4 * 1024 * 1024) return;
      for (const part of value.split('\x1e')) {
        const event = fuzhouSocketEvent(part);
        if (
          !event ||
          !['games', 'newgame', 'updategame', 'removegame'].includes(event[0]) ||
          !Array.isArray(event[1]) ||
          event[1].length > 2000
        )
          continue;
        const stamp = now(),
          [kind, rows] = event;
        if (kind === 'removegame') {
          if (fullObservedAt === null || rows.some((row) => !object(row) || !text(row.id, 100))) continue;
          for (const row of rows) rooms.delete(row.id);
        } else {
          const projected = rows.map((row) => publicLobbyRow(row, stamp));
          if (
            projected.some((row) => !row) ||
            new Set(projected.map((row) => row.id)).size !== projected.length
          )
            continue;
          if (kind === 'games') {
            rooms = new Map(projected.map((row) => [row.id, row]));
            fullObservedAt = stamp;
          } else {
            if (fullObservedAt === null) continue;
            for (const row of projected) rooms.set(row.id, row);
          }
        }
        observedAt = stamp;
        ordinal++;
      }
    },
    snapshot() {
      return fullObservedAt === null
        ? null
        : {
            source: 'native-lobby',
            nativeFullRoster: true,
            observedAt,
            fullObservedAt,
            ordinal,
            rooms: structuredClone([...rooms.values()]),
          };
    },
  };
}

export function observeNativeLobby(page, { origin } = {}) {
  exactSiteOrigin(origin);
  const roster = createNativeLobbyRoster(),
    sockets = [];
  const receive = ({ payload }) => roster.ingest(payload);
  const onSocket = (socket) => {
    if (!lobbyUrl(socket.url(), origin)) return;
    socket.on('framereceived', receive);
    sockets.push(socket);
  };
  let closed = false;
  const onResponse = async (response) => {
    const url = lobbyUrl(response.url(), origin);
    if (!url || url.searchParams.get('transport') !== 'polling' || response.request().method() !== 'GET')
      return;
    try {
      const value = await response.text();
      if (!closed) roster.ingest(value);
    } catch {}
  };
  page.on('websocket', onSocket);
  page.on('response', onResponse);
  return {
    snapshot: roster.snapshot,
    close() {
      closed = true;
      page.off('websocket', onSocket);
      page.off('response', onResponse);
      for (const socket of sockets) socket.off('framereceived', receive);
    },
  };
}

/** A fresh anonymous document supplies a complete roster; it cannot replace an account session. */
export async function readLobbyFromBrowser(browser, { origin, timeoutMs = 15000 } = {}) {
  exactSiteOrigin(origin);
  const context = await browser.newContext();
  let observer;
  try {
    const page = await context.newPage();
    observer = observeNativeLobby(page, { origin });
    const deadline = Date.now() + timeoutMs;
    const response = await page.goto(origin + '/play', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response?.ok() || new URL(page.url()).origin !== origin) throw Error('LOBBY_NAVIGATION_UNVERIFIED');
    while (!observer.snapshot() && Date.now() < deadline) await pause(100);
    const snapshot = observer.snapshot();
    if (!snapshot) throw Error('NATIVE_FULL_LOBBY_UNAVAILABLE');
    return { ...snapshot, capturedAt: Date.now(), anonymous: true, origin };
  } finally {
    observer?.close();
    await context.close();
  }
}

export async function readCampaignLobby({ profileDir, agentId, origin, timeoutMs = 60000 }) {
  if (!path.isAbsolute(profileDir) || !text(agentId, 200)) throw Error('LOBBY_PROFILE_REQUIRED');
  exactSiteOrigin(origin);
  const { AgentBrowser } = await import('./browser-provider.mjs');
  const pool = new AgentBrowser({ keepAlive: false, cleanupOnExit: true, extraArgs: [] });
  try {
    const instance = await pool.getBrowser(agentId, {
      mode: 'per-agent',
      profileDir,
      inherit: false,
      headless: true,
    });
    return await readLobbyFromBrowser(instance.browser, { origin, timeoutMs });
  } finally {
    await pool.closeAll();
  }
}
