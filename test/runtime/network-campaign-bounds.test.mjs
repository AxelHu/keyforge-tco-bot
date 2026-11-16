import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeBrowserNetwork, browserNetworkArgs } from '../../tools/browser-network.mjs';
import { normalizeHumanConfig, humanPreflight } from '../../tools/keyteki-human-config.mjs';
import { initializeConfig, prepareCampaign } from '../../tools/cli.mjs';
import { normalizeCampaignConfig, campaignBudget, runLiveCampaign, campaignControl } from '../../tools/keyteki-live-campaign.mjs';
import { createPublicTransportDiagnostics } from '../../tools/keyteki-public-transport-diagnostics.mjs';

const seat = () => ({ schema: 'keyteki-human-one-seat-draft-v1', origin: 'https://thecrucible.online',
  self: { name: 'ExampleBot', serverDeckId: 123, deckName: 'Example Deck' },
  room: { name: 'AI game', gameType: 'beginner', gameFormat: 'normal' },
  credentialsPath: '/local/credentials.json', output: '/local/attempt',
});
const input = (output = '/local/campaign') => ({ schema: 'keyteki-live-campaign-v1', id: 'network-test', output,
  runtimeManifest: '/local/runtime/runtime-manifest.json', runtimeManifestSha256: 'a'.repeat(64),
  minimumFreeBytes: 128 * 1024 ** 2, betweenGamesMs: 1000, emptyRetryMs: 1000, seat: seat(),
});
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-network-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('explicit browser routing preserves system default and excludes credentials and ambiguous endpoints', () => {
  assert.deepEqual(browserNetworkArgs(), []);
  assert.deepEqual(browserNetworkArgs({ mode: 'direct' }), ['--no-proxy-server']);
  assert.deepEqual(browserNetworkArgs({ mode: 'proxy', server: 'http://127.0.0.1:7890' }),
    ['--proxy-server=http://127.0.0.1:7890', '--proxy-bypass-list=localhost;127.0.0.1;[::1]']);
  assert.equal(normalizeBrowserNetwork({ mode: 'proxy', server: 'socks5://[::1]:1080' }).server, 'socks5://[::1]:1080');
  for (const value of [null, [], {}, { mode: 'DIRECT' }, { mode: 'direct', server: 'http://localhost:1' },
    { mode: 'system', extraArgs: ['--anything'] }, { mode: 'proxy' }])
    assert.throws(() => normalizeBrowserNetwork(value), /BROWSER_NETWORK_INVALID/);
  for (const server of ['http://user:secret@host:1', 'http://host/path', 'http://host?secret=1', 'http://host#x',
    'http://host:0', 'http://host:65536', 'http://host:1;DIRECT', 'file:///proxy.pac', 'socks4://host:1',
    ' http://host:1', 'http://host:1\n--no-sandbox', 'http://h%6fst:1'])
    assert.throws(() => normalizeBrowserNetwork({ mode: 'proxy', server }), /BROWSER_NETWORK_INVALID/);
  const value = { ...seat(), network: { mode: 'proxy', server: 'http://localhost:7890' } };
  assert.deepEqual(normalizeHumanConfig(value, { createPublic: true }).network, value.network);
  assert.deepEqual(normalizeCampaignConfig({ ...input(), seat: value }).network, value.network);
});

test('CLI routing choices and finite campaign limits persist before execution', (t) => {
  const root = temporary(t), directory = path.join(root, 'seat');
  const args = ['--directory', directory, '--origin', 'https://thecrucible.online', '--account', 'ExampleBot',
    '--server-deck-id', '123', '--deck-name', 'Example Deck', '--network', 'proxy', '--proxy-server', 'http://localhost:7890'];
  const init = initializeConfig(args);
  assert.equal(init.browserStarted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(init.config)).network, { mode: 'proxy', server: 'http://localhost:7890' });
  const manifest = path.join(root, 'runtime-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'kf-live-runtime-freeze-v1', root: path.join(root, 'runtime'), files: [] }));
  const baseArgs = ['--seat', init.config, '--manifest', manifest, '--config', path.join(root, 'campaign.json'),
    '--output', path.join(root, 'data'), '--id', 'bounded-campaign'];
  const prepared = prepareCampaign([...baseArgs, '--max-natural-games', '10', '--max-attempts', '12', '--max-elapsed-ms', '14400000']);
  assert.equal(prepared.browserStarted, false);
  const saved = JSON.parse(fs.readFileSync(prepared.config));
  assert.equal(saved.maxNaturalGames, 10); assert.equal(saved.maxAttempts, 12); assert.equal(saved.maxElapsedMs, 14400000);
  assert.deepEqual(saved.seat.network, init.network);
  for (const [id, flags, code] of [
    ['bad-route', ['--network', 'proxy', '--proxy-server', 'http://name:secret@localhost:7890'], /BROWSER_NETWORK_INVALID/],
    ['duplicate', ['--network', 'direct', '--network', 'system'], /NETWORK_OPTION_DUPLICATED/],
  ]) {
    const target = path.join(root, id);
    assert.throws(() => initializeConfig([...args.slice(0, 2).map((x, i) => i === 1 ? target : x), ...args.slice(2, 10), ...flags]), code);
    assert.equal(fs.existsSync(target), false);
  }
});

test('campaign budget counts distinct natural games, all attempts, and elapsed time across pauses', () => {
  const config = normalizeCampaignConfig({ ...input(), maxNaturalGames: 2, maxAttempts: 4, maxElapsedMs: 1000 });
  const state = { createdAt: '2026-01-01T00:00:00.000Z', attemptsStarted: 3, activeAttempt: null,
    records: [{ gameId: 'g1', natural: true, canContinue: true }, { gameId: 'g2', natural: false, canContinue: true }] };
  const started = Date.parse(state.createdAt);
  assert.equal(campaignBudget(config, state, started + 999).reached, false);
  assert.deepEqual(campaignBudget(config, state, started + 1000).reasons, ['elapsed-time-limit']);
  const later = { ...state, attemptsStarted: 4, records: [...state.records, { gameId: 'g3', natural: true, canContinue: true }] };
  assert.deepEqual(campaignBudget(config, later, started + 1001).reasons, ['natural-game-limit', 'attempt-limit', 'elapsed-time-limit']);
  assert.throws(() => campaignBudget(config, state, started - 1), /CAMPAIGN_BUDGET_STATE_INVALID/);
  assert.throws(() => campaignBudget(config, { ...state, attemptsStarted: 1 }, started), /CAMPAIGN_BUDGET_STATE_INVALID/);
  for (const key of ['maxNaturalGames', 'maxAttempts', 'maxElapsedMs'])
    for (const value of [0, -1, 1.5, '10', Infinity])
      assert.throws(() => normalizeCampaignConfig({ ...input(), [key]: value }), /CAMPAIGN_BUDGET_INVALID/);
});

function dependencies(clock, onLobby, onSpawn) {
  let attempts = 0, leaseClosed = 0, lobbyCalls = 0;
  const deps = {
    now: () => clock.value,
    acquire: async () => ({ healthy: () => true, close: () => { leaseClosed++; } }),
    verifyRuntime: () => ({ sourceCommit: 'fixture' }),
    readLobby: async (options) => {
      lobbyCalls++; await onLobby?.(options);
      return { source: 'native-lobby', nativeFullRoster: true, observedAt: Date.now(), rooms: [] };
    },
    spawnWorker: (_exe, args) => {
      attempts++;
      const file = args[args.indexOf('--config') + 1], value = JSON.parse(fs.readFileSync(file));
      const child = new EventEmitter(); child.pid = 10000 + attempts;
      child.kill = () => { throw Error('A budget must never terminate an in-flight game'); };
      setImmediate(async () => {
        await onSpawn?.(value);
        const gameId = 'fixture-' + attempts, self = value.self.name, opponent = 'FixtureHuman';
        fs.mkdirSync(value.output, { recursive: true });
        fs.writeFileSync(path.join(value.output, 'handoff.json'), JSON.stringify({
          gameId, participants: [self, opponent], fullVerified: true, finished: true, runtimeRetired: true,
          finalPublicView: { gameId, playerName: self, started: true, winner: self,
            players: { [self]: { keys: ['red', 'blue', 'yellow'] }, [opponent]: { keys: ['red'] } } },
          roomExit: { gameId, playerName: self, phase: 'left-confirmed', serverSeatAbsent: true,
            server: { gameId, playerName: self, serverSeatAbsent: true, seatPresent: false,
              ownSeatPreviouslyObserved: true, source: 'removegame', ordinal: 2 } },
        }));
        child.emit('exit', 0);
      });
      return child;
    },
  };
  return { deps, counts: () => ({ attempts, leaseClosed, lobbyCalls }) };
}

test('deadline reached during lobby read blocks dispatch and propagates the selected network', async (t) => {
  const config = { ...input(path.join(temporary(t), 'data')), maxElapsedMs: 1000,
    seat: { ...seat(), network: { mode: 'direct' } } };
  const clock = { value: Date.now() };
  const fixture = dependencies(clock, async (options) => {
    assert.deepEqual(options.network, { mode: 'direct' }); clock.value += 1000;
  });
  const state = await runLiveCampaign(config, fixture.deps);
  assert.equal(state.phase, 'completed-budget'); assert.equal(state.activeAttempt, null);
  assert.equal(state.budget.attemptsStarted, 0); assert.equal(fixture.counts().attempts, 0);
  assert.equal(fixture.counts().leaseClosed, 1);
});

test('elapsed budget lets the dispatched game retire naturally and cannot reset on restart', async (t) => {
  const config = { ...input(path.join(temporary(t), 'data')), maxElapsedMs: 1000, maxAttempts: 1 };
  const clock = { value: Date.now() };
  const fixture = dependencies(clock, null, async () => { clock.value += 5000; });
  const state = await runLiveCampaign(config, fixture.deps);
  assert.equal(state.phase, 'completed-budget'); assert.equal(state.activeAttempt, null);
  assert.equal(state.records[0].outcome, 'natural'); assert.equal(state.records[0].canContinue, true);
  assert.equal(state.budget.attemptsStarted, 1); assert.equal(fixture.counts().attempts, 1);
  const before = state.createdAt;
  const resumed = await runLiveCampaign(config, fixture.deps);
  assert.equal(resumed.createdAt, before); assert.equal(fixture.counts().attempts, 1);
  assert.throws(() => campaignControl(config, 'enable-unattended'), /CAMPAIGN_BUDGET_EXHAUSTED/);
});

test('the original three-natural-game observation gate remains before unattended admission', async (t) => {
  const config = { ...input(path.join(temporary(t), 'data')), maxNaturalGames: 10, maxAttempts: 12 };
  const clock = { value: Date.now() };
  const fixture = dependencies(clock);
  const state = await runLiveCampaign(config, fixture.deps);
  assert.equal(fixture.counts().attempts, 3); assert.equal(state.health.stable, true);
  assert.deepEqual(state.pauseReasons, ['observation-complete-awaiting-operator-inspection']);
  assert.equal(state.activeAttempt, null);
});

test('passive socket diagnostics recognize international node paths without widening origin or credential guards', () => {
  const rows = [], page = new EventEmitter();
  page.context = () => null;
  const d = createPublicTransportDiagnostics({ origin: 'https://thecrucible.online',
    gameSocketPaths: ['https://node.example/node-2/socket.io'], record: (row) => rows.push(row) });
  d.observePage(page, 'ExampleBot');
  const open = (url) => {
    const socket = new EventEmitter(); socket.url = () => url;
    socket.send = () => { throw Error('passive diagnostics must not send'); };
    page.emit('websocket', socket); socket.emit('framereceived', { payload: '2' });
  };
  for (const url of ['wss://thecrucible.online/node-0/socket.io/?EIO=4',
    'wss://thecrucible.online/node-1/socket.io/?EIO=4', 'wss://thecrucible.online/node1/socket.io/?EIO=3',
    'wss://node.example/node-2/socket.io/?EIO=4']) open(url);
  for (const url of ['wss://elsewhere.example/node-1/socket.io', 'wss://node.example/node-3/socket.io',
    'wss://name:secret@thecrucible.online/node-1/socket.io', 'ws://thecrucible.online/node-1/socket.io',
    'wss://thecrucible.online/node-01/socket.io', 'wss://thecrucible.online/node0/socket.io',
    'wss://thecrucible.online/other/socket.io', 'wss://thecrucible.online/node-1/socket.io/extra']) open(url);
  const summary = d.finish();
  assert.equal(summary.eventCounts['socket-open-observed'], 4);
  assert.equal(summary.eventCounts['protocol-control-frame'], 4);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.equal(summary.observerErrors, 0);
});

test('single-seat preflight binds the network and retirement helpers in its source inventory', () => {
  const report = humanPreflight(seat(), { createPublic: true }).report;
  for (const name of ['tools/browser-network.mjs', 'tools/keyteki-finished-runtime-retirement.mjs']) {
    const row = report.files.find((value) => value.name === name);
    assert.ok(row, name); assert.equal(row.available, true); assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
});
