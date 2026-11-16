import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHumanConfig, makeOneSeatBridgeConfig, humanPreflight } from '../../tools/keyteki-human-config.mjs';
import { normalizeCampaignConfig } from '../../tools/keyteki-live-campaign.mjs';
import { configuredMinimaxKey } from '../../tools/minimax-credentials.mjs';
import { exactSiteOrigin, normalizeGameSocketPaths } from '../../tools/site-origin.mjs';
import { keytekiTransportBinding } from '../../tools/keyteki-transport-recovery.mjs';

const input = () => ({
  schema: 'keyteki-human-one-seat-draft-v1',
  origin: 'https://keyteki.example',
  self: {
    name: 'ExampleBot',
    serverDeckId: 987,
    deckName: 'Example public deck',
    codePolicy: 'tactical-style-engine-v3',
  },
  room: { name: 'AI example', gameType: 'beginner', gameFormat: 'normal' },
  credentialsPath: '/local/credentials.json',
  output: '/local/attempt',
});
test('portable public creation uses the explicitly supplied account, deck and exact origin', () => {
  const config = normalizeHumanConfig(input(), { createPublic: true });
  assert.equal(config.origin, 'https://keyteki.example');
  assert.equal(config.self.name, 'ExampleBot');
  assert.equal(config.self.serverDeckId, 987);
  assert.deepEqual(config.ownAccountNames, ['ExampleBot']);
  assert.deepEqual(config.social, { enabled: false, language: 'zh-CN' });
  assert.deepEqual(config.gameSocketPaths, []);
});
test('configuration has no implicit server, credential, opponent or account fallback', () => {
  const value = input();
  delete value.origin;
  assert.throws(() => normalizeHumanConfig(value, { createPublic: true }), /ORIGIN/);
  assert.throws(() => normalizeHumanConfig(input()), /EXPLICIT_OBSERVED_ROOM_PAIR_REQUIRED/);
  assert.throws(
    () => normalizeHumanConfig({ ...input(), credentialsPath: 'relative.json' }, { createPublic: true }),
    /ABSOLUTE_LOCAL_PATHS_REQUIRED/,
  );
  assert.throws(
    () =>
      normalizeHumanConfig(
        { ...input(), self: { ...input().self, password: 'must-not-be-configured-here' } },
        { createPublic: true },
      ),
    /OWN_ACCOUNT_CONFIG/,
  );
  for (const origin of [
    'https://keyteki.example/',
    'https://name:secret@keyteki.example',
    'file:///local',
    'https://keyteki.example/path',
  ])
    assert.throws(() => exactSiteOrigin(origin));
});
test('a joined bridge remains bound to exactly one configured seat and two observed participants', () => {
  const value = input();
  value.room.gameId = 'observed-game';
  value.room.opponentName = 'ExternalUser';
  const config = normalizeHumanConfig(value),
    bridge = makeOneSeatBridgeConfig(config);
  assert.deepEqual(bridge.players, [
    { name: 'ExampleBot', mode: 'code', codePolicy: 'tactical-style-engine-v3' },
  ]);
  assert.deepEqual(bridge.participants, ['ExampleBot', 'ExternalUser']);
  assert.deepEqual(bridge.social, { enabled: false });
  assert.equal(bridge.managedSessions, true);
  assert.throws(
    () => normalizeHumanConfig({ ...value, ownAccountNames: ['ExternalUser'] }),
    /EXTERNAL_OPPONENT_REQUIRED/,
  );
});
test('social credentials are optional and read only from the explicit environment input', () => {
  assert.throws(() => configuredMinimaxKey({}), /MINIMAX_API_KEY_REQUIRED/);
  assert.equal(configuredMinimaxKey({ MINIMAX_API_KEY: 'test-only-value' }), 'test-only-value');
  assert.throws(() => configuredMinimaxKey({ MINIMAX_API_KEY: 'line\nbreak' }));
  const value = input();
  value.social = { enabled: true, model: 'MiniMax-M3.1-Flash', maxOutputTokens: 2048 };
  assert.equal(normalizeHumanConfig(value, { createPublic: true }).social.enabled, true);
  value.social.apiKey = 'not-a-config-field';
  assert.throws(() => normalizeHumanConfig(value, { createPublic: true }), /SOCIAL_CONFIG_INVALID/);
});
test('cross-origin game transport requires an exact configured endpoint, never a host or port exception', () => {
  const origin = 'https://keyteki.example',
    path = 'https://node.example:9500/node1/socket.io';
  assert.deepEqual(keytekiTransportBinding({ epoch: 1, path: origin + '/node1/socket.io' }, origin), {
    epoch: 1,
    path: origin + '/node1/socket.io',
  });
  assert.throws(() => keytekiTransportBinding({ epoch: 1, path }, origin), /transport-path-invalid/);
  const allowed = normalizeGameSocketPaths([path]);
  assert.equal(keytekiTransportBinding({ epoch: 1, path }, origin, allowed).path, path);
  for (const wrong of [
    path.replace('node1', 'node2'),
    path.replace('9500', '9501'),
    path + '?x=1',
    path.replace('node.example', 'other.example'),
  ])
    assert.throws(() => keytekiTransportBinding({ epoch: 1, path: wrong }, origin, allowed));
  assert.throws(() => normalizeGameSocketPaths(['https://node.example/*']));
  const value = input();
  value.gameSocketPaths = allowed;
  value.room.gameId = 'game';
  value.room.opponentName = 'ExternalUser';
  assert.deepEqual(makeOneSeatBridgeConfig(normalizeHumanConfig(value)).gameSocketPaths, allowed);
});
test('campaign policy selection and disk budget are portable while lifecycle guards remain mandatory', () => {
  const seat = input();
  seat.self.codePolicy = 'tempo-v3';
  const campaign = {
    schema: 'keyteki-live-campaign-v1',
    id: 'example-campaign',
    output: '/local/campaign',
    runtimeManifest: '/local/runtime/runtime-manifest.json',
    runtimeManifestSha256: 'a'.repeat(64),
    minimumFreeBytes: 1024 ** 3,
    seat,
  };
  assert.equal(normalizeCampaignConfig(campaign).minimumFreeBytes, 1024 ** 3);
  assert.equal(normalizeCampaignConfig(campaign).selfName, 'ExampleBot');
  assert.throws(
    () => normalizeCampaignConfig({ ...campaign, seat: { ...seat, watchdog: { enabled: false } } }),
    /CAMPAIGN_LIFECYCLE_REQUIRED/,
  );
  assert.throws(
    () => normalizeCampaignConfig({ ...campaign, seat: { ...seat, leaveAfterFinish: false } }),
    /CAMPAIGN_LIFECYCLE_REQUIRED/,
  );
});

test('public creation and campaign preserve explicit beginner or casual room types', () => {
  for (const gameType of ['beginner', 'casual']) {
    const seat = input();
    seat.room.gameType = gameType;
    const config = normalizeHumanConfig(seat, { createPublic: true });
    assert.equal(config.room.gameType, gameType);
    assert.equal(config.room.gameFormat, 'normal');
    assert.equal(config.createPublic, true);
    assert.equal(humanPreflight(seat, { createPublic: true }).report.entry, 'create-one-public-' + gameType + '-room');
    const campaign = normalizeCampaignConfig({
      schema: 'keyteki-live-campaign-v1', id: 'room-type-test', output: '/local/campaign',
      runtimeManifest: '/local/runtime/runtime-manifest.json', runtimeManifestSha256: 'a'.repeat(64), seat,
    });
    assert.equal(campaign.seat.room.gameType, gameType);
  }
});

test('casual creation keeps competitive, disclosure, normal-format and unbound-pair guards', () => {
  for (const [change, code] of [
    [{ gameType: 'competitive' }, 'PUBLIC_CREATION_SCOPE_CHANGED'],
    [{ gameType: 'unknown' }, 'OBSERVED_NORMAL_DECK_FLOW_REQUIRED'],
    [{ gameFormat: 'sealed' }, 'OBSERVED_NORMAL_DECK_FLOW_REQUIRED'],
    [{ name: 'Example room' }, 'PUBLIC_CREATION_SCOPE_CHANGED'],
    [{ gameId: 'existing-room' }, 'PUBLIC_CREATION_SCOPE_CHANGED'],
    [{ opponentName: 'ExternalUser' }, 'PUBLIC_CREATION_SCOPE_CHANGED'],
  ]) {
    const seat = input();
    seat.room = { ...seat.room, gameType: 'casual', ...change };
    assert.throws(() => normalizeHumanConfig(seat, { createPublic: true }), { code });
    assert.throws(() => normalizeCampaignConfig({
      schema: 'keyteki-live-campaign-v1', id: 'room-type-test', output: '/local/campaign',
      runtimeManifest: '/local/runtime/runtime-manifest.json', runtimeManifestSha256: 'a'.repeat(64), seat,
    }), { code });
  }
});
