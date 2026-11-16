/** Draft, offline configuration/preflight. This module never reads credentials or opens a socket. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fuzhouDeckSpec } from './keyteki-fuzhou-ui.mjs';
import { exactSiteOrigin, normalizeGameSocketPaths } from './site-origin.mjs';
import { normalizeWatchdogConfig } from './keyteki-human-watchdog.mjs';
import { DEFAULT_CODE_POLICY, assertRegisteredCodePolicy } from './strategy-menu.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_MODULE = new URL('./browser-provider.mjs', import.meta.url).href;
export const HUMAN_SCHEMA = 'keyteki-human-one-seat-draft-v1';
export const HUMAN_DEFAULT_ROOM_NAME = 'AI game';
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const text = (x, max = 160) =>
  typeof x === 'string' && x.trim() && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const absolute = (x) => typeof x === 'string' && path.isAbsolute(x);

export function normalizeHumanConfig(value, { createPublic = false } = {}) {
  if (!object(value) || value.schema !== HUMAN_SCHEMA) fail('HUMAN_CONFIG_SCHEMA');
  const origin = exactSiteOrigin(value.origin);
  for (const key of [
    'publicCaptureRuleContract',
    'publicVeilRuleContract',
    'verifiedVeilScope',
    'providerModule',
    'players',
    'participants',
    'deckLists',
  ])
    if (Object.hasOwn(value, key)) fail('UNSUPPORTED_HUMAN_CONFIG_FIELD');
  const self = value.self,
    room = object(value.room)
      ? { ...value.room, name: value.room.name ?? HUMAN_DEFAULT_ROOM_NAME }
      : value.room;
  if (!object(self) || !/^[A-Za-z0-9_-]{3,15}$/.test(self.name ?? '') || Object.hasOwn(self, 'password'))
    fail('OWN_ACCOUNT_CONFIG');
  const ownDeck = fuzhouDeckSpec(self);
  if (self.mode !== undefined && self.mode !== 'code') fail('PURE_CODE_SEAT_REQUIRED');
  if (!object(room) || !text(room.name, 100)) fail('EXPLICIT_ROOM_NAME_REQUIRED');
  if (
    !createPublic &&
    (!text(room.gameId, 100) || !text(room.opponentName, 160) || room.opponentName === self.name)
  )
    fail('EXPLICIT_OBSERVED_ROOM_PAIR_REQUIRED');
  // The observed frontend calls ordinary Archon "normal", not "archon".
  if (!['beginner', 'casual', 'competitive'].includes(room.gameType) || room.gameFormat !== 'normal')
    fail('OBSERVED_NORMAL_DECK_FLOW_REQUIRED');
  if (
    createPublic &&
    (room.gameType !== 'beginner' ||
      !/(?:\bAI\b|人工智能)/iu.test(room.name) ||
      room.gameId !== undefined ||
      room.opponentName !== undefined)
  )
    fail('PUBLIC_CREATION_SCOPE_CHANGED');
  if (!absolute(value.credentialsPath) || !absolute(value.output)) fail('ABSOLUTE_LOCAL_PATHS_REQUIRED');
  if (path.parse(path.resolve(value.output)).root === path.resolve(value.output))
    fail('OUTPUT_DIRECTORY_REQUIRED');
  const codePolicy = self.codePolicy ?? DEFAULT_CODE_POLICY;
  if (!/^[a-z][a-z0-9-]{1,100}$/.test(codePolicy)) fail('CODE_POLICY_ID_INVALID');
  assertRegisteredCodePolicy(codePolicy);
  const ownPublicDeckList = value.ownPublicDeckList;
  if (
    ownPublicDeckList !== undefined &&
    (!Array.isArray(ownPublicDeckList) ||
      !ownPublicDeckList.length ||
      ownPublicDeckList.some(
        (row) =>
          !object(row) ||
          !text(row.definition, 100) ||
          !text(row.name, 200) ||
          !text(row.house, 40) ||
          !Number.isSafeInteger(row.count) ||
          row.count < 1 ||
          row.count > 36,
      ) ||
      ownPublicDeckList.reduce((n, row) => n + row.count, 0) !== 36)
  )
    fail('OWN_PUBLIC_COMPOSITION_INVALID');
  if (value.leaveAfterFinish !== undefined && typeof value.leaveAfterFinish !== 'boolean')
    fail('FINISHED_LEAVE_SETTING_INVALID');
  if (value.decisionEvidence !== undefined && typeof value.decisionEvidence !== 'boolean')
    fail('DECISION_EVIDENCE_SETTING_INVALID');
  const timeoutMs = value.setupTimeoutMs ?? 45000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000)
    fail('SETUP_DEADLINE_INVALID');
  if (value.ownAccountNames !== undefined && !Array.isArray(value.ownAccountNames))
    fail('OWN_ACCOUNT_NAMES_INVALID');
  const ownAccountNames = [...new Set([self.name, ...(value.ownAccountNames ?? [])])];
  if (ownAccountNames.some((name) => !text(name))) fail('OWN_ACCOUNT_NAMES_INVALID');
  if (!createPublic && ownAccountNames.includes(room.opponentName)) fail('EXTERNAL_OPPONENT_REQUIRED');
  const waitForOpponentMs = value.waitForOpponentMs ?? 180000;
  if (
    createPublic &&
    (!Number.isSafeInteger(waitForOpponentMs) || waitForOpponentMs < 1000 || waitForOpponentMs > 180000)
  )
    fail('OPPONENT_WAIT_BOUND_INVALID');
  const social = value.social ?? { enabled: false };
  if (
    !object(social) ||
    typeof social.enabled !== 'boolean' ||
    Object.keys(social).some((key) => !['enabled', 'model', 'timeoutMs', 'maxOutputTokens'].includes(key))
  )
    fail('SOCIAL_CONFIG_INVALID');
  if (
    social.model !== undefined &&
    !['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview'].includes(social.model)
  )
    fail('SOCIAL_MODEL_INVALID');
  for (const key of ['timeoutMs', 'maxOutputTokens'])
    if (
      social[key] !== undefined &&
      (!Number.isSafeInteger(social[key]) ||
        social[key] < 1 ||
        social[key] > (key === 'timeoutMs' ? 180000 : 8192))
    )
      fail('SOCIAL_LIMIT_INVALID');
  return Object.freeze({
    schema: HUMAN_SCHEMA,
    origin,
    gameSocketPaths: normalizeGameSocketPaths(value.gameSocketPaths),
    self: { name: self.name, ...ownDeck, mode: 'code', codePolicy },
    room: {
      name: room.name,
      gameType: room.gameType,
      gameFormat: 'normal',
      ...(!createPublic ? { gameId: room.gameId, opponentName: room.opponentName } : {}),
    },
    participants: createPublic ? [self.name] : [self.name, room.opponentName],
    createPublic,
    ...(createPublic ? { waitForOpponentMs } : {}),
    credentialsPath: path.resolve(value.credentialsPath),
    output: path.resolve(value.output),
    profile: path.join(path.resolve(value.output), 'host'),
    browserProfile: path.join(path.resolve(value.output), 'browser-profile'),
    headless: value.headless !== false,
    setupTimeoutMs: timeoutMs,
    leaveAfterFinish: value.leaveAfterFinish !== false,
    decisionEvidence: value.decisionEvidence === true,
    watchdog: normalizeWatchdogConfig(value.watchdog),
    ownAccountNames,
    social: {
      enabled: social.enabled,
      ...(social.enabled
        ? {
            model: social.model ?? 'MiniMax-M3.1-Flash',
            timeoutMs: social.timeoutMs ?? 60000,
            maxOutputTokens: social.maxOutputTokens ?? 8192,
          }
        : {}),
    },
    ...(ownPublicDeckList
      ? {
          ownPublicDeckList: ownPublicDeckList.map(({ definition, name, house, count }) => ({
            definition,
            name,
            house,
            count,
          })),
        }
      : {}),
    ...(!createPublic ? { gameUrl: origin + '/play?gameId=' + encodeURIComponent(room.gameId) } : {}),
  });
}

export function makeOneSeatBridgeConfig(config) {
  if (
    config.createPublic ||
    config.participants.length !== 2 ||
    !config.room.gameId ||
    !config.room.opponentName
  )
    fail('PAIR_MUST_BE_LOCKED_BEFORE_HOST');
  return {
    origins: [config.origin],
    gameSocketPaths: [...config.gameSocketPaths],
    participants: [...config.participants],
    managedSessions: true,
    ...(config.decisionEvidence ? { decisionEvidence: true, decisionEvidenceOutput: config.output } : {}),
    players: [{ name: config.self.name, mode: 'code', codePolicy: config.self.codePolicy }],
    ...(config.ownPublicDeckList ? { deckLists: { [config.self.name]: config.ownPublicDeckList } } : {}),
    social: config.social.enabled
      ? { ...config.social, knownBotNames: config.ownAccountNames }
      : { enabled: false },
  };
}

const sources = [
  'tools/keyteki-human-config.mjs',
  'tools/browser-provider.mjs',
  'tools/browser-paths.mjs',
  'tools/site-origin.mjs',
  'tools/minimax-credentials.mjs',
  'tools/keyteki-human-watchdog.mjs',
  'tools/keyteki-human-watchdog-browser.mjs',
  'tools/keyteki-finished-room-exit.mjs',
  'tools/keyteki-joined-pending-exit.mjs',
  'tools/keyteki-live-lobby.mjs',
  'tools/keyteki-finished-chat-drain.mjs',
  'tools/keyteki-owned-browser-release.mjs',
  'tools/keyteki-human-public-room-ui.mjs',
  'tools/keyteki-human-launcher.mjs',
  'tools/keyteki-human-create-public.mjs',
  'tools/keyteki-human-bridge-callback.mjs',
  'tools/keyteki-session-host.mjs',
  'tools/keyteki-host-operator-intent.mjs',
  'tools/keyteki-browser-bridge.mjs',
  'tools/keyteki-managed-sessions.mjs',
  'tools/keyteki-wire-session.mjs',
  'tools/keyteki-decision-evidence.mjs',
  'tools/keyteki-shared-strategy.user.js',
  'tools/keyteki-browser-bootstrap.mjs',
  'tools/keyteki-fuzhou-ui.mjs',
  'tools/keyteki-public-browser-game.mjs',
  'tools/keyteki-public-managed-observation.mjs',
  'tools/keyteki-social-projection.mjs',
  'tools/keyteki-social-session.mjs',
  'tools/minimax-social-provider.mjs',
  'dist/src/ai/code-strategies.js',
];
export function humanPreflight(input, options) {
  const config = normalizeHumanConfig(input, options);
  const files = sources.map((name) => {
    const file = path.join(REPO_ROOT, name);
    return {
      name,
      available: fs.existsSync(file),
      ...(fs.existsSync(file)
        ? { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
        : {}),
    };
  });
  const credentialExists = fs.existsSync(config.credentialsPath);
  const credentialPrivate =
    credentialExists &&
    fs.statSync(config.credentialsPath).isFile() &&
    (fs.statSync(config.credentialsPath).mode & 0o077) === 0;
  return {
    config,
    report: {
      schema: HUMAN_SCHEMA,
      mode: 'offline-preflight',
      networkRequests: 0,
      credentialContentsRead: false,
      origin: config.origin,
      gameId: config.room.gameId ?? null,
      participants: config.participants,
      entry: config.createPublic ? 'create-one-public-beginner-room' : 'join-observed-public-room',
      ...(config.createPublic
        ? { waitForOpponentMs: config.waitForOpponentMs, pairLockRequiredBeforeHost: true }
        : {}),
      controlledAccounts: [config.self.name],
      codePolicy: config.self.codePolicy,
      opponentDeckList: 'unknown; visible board remains available',
      publicRuleContracts: [],
      aiChat: config.social.enabled
        ? {
            enabled: true,
            model: config.social.model,
            tools: false,
            credentialSource: 'MINIMAX_API_KEY environment variable',
          }
        : { enabled: false },
      watchdog: config.watchdog,
      leaveAfterFinish: config.leaveAfterFinish,
      credentials: { exists: credentialExists, privateMode: credentialPrivate },
      outputFresh: !fs.existsSync(config.output),
      browserHelperAvailable: fs.existsSync(fileURLToPath(BROWSER_MODULE)),
      files,
      readyForExplicitRun:
        credentialPrivate &&
        !fs.existsSync(config.output) &&
        files.every((row) => row.available) &&
        fs.existsSync(fileURLToPath(BROWSER_MODULE)),
      runtimeChecksStillRequired: [
        config.createPublic
          ? 'Only our created public, unpassworded beginner/normal room may bind one non-owned opponent before host startup'
          : 'Fresh native listing must match the supplied room/pair and remain public, unstarted, unpassworded and one-seat-open',
        'Observed SPA join and existing Select deck controls must be present on the current frontend',
        'Only our own selected deck and first native full game view may activate the controller',
      ],
    },
  };
}
