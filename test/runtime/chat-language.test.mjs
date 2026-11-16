import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeChatLanguage, watchdogApology } from '../../tools/keyteki-language.mjs';
import { createKeytekiSocialSession, buildSocialPrompt, SOCIAL_PERSONA, SOCIAL_PERSONA_EN } from '../../tools/keyteki-social-session.mjs';
import { buildMinimaxSocialBody } from '../../tools/minimax-social-provider.mjs';
import { normalizeHumanConfig, makeOneSeatBridgeConfig } from '../../tools/keyteki-human-config.mjs';
import { createBridgeSocial } from '../../tools/keyteki-bridge-social.mjs';
import { initializeConfig } from '../../tools/cli.mjs';

const fixture = (origin = 'https://thecrucible.online') => {
  const binding = { origin, gameId: 'language-fixture', playerName: 'Self', opponentName: 'Visitor', ownerEpoch: '1' };
  const snapshot = { ...binding, revision: 1, turn: 1, ready: true, started: true, finished: false,
    self: { name: 'Self', keys: 0, amber: 0, keyCost: 6, creatures: 0, readyCreatures: 0, deckName: 'Long public deck name '.repeat(10), hiddenHand: ['SECRET'] },
    opponent: { name: 'Visitor', keys: 0, amber: 0, keyCost: 6, creatures: 0, readyCreatures: 0 }, recentChat: [],
  };
  return { binding, snapshot };
};
const seat = (origin) => ({
  schema: 'keyteki-human-one-seat-draft-v1', origin,
  self: { name: 'ExampleBot', serverDeckId: 123, deckName: 'Example Deck' },
  room: { name: 'AI game', gameType: 'beginner', gameFormat: 'normal', gameId: 'language-fixture', opponentName: 'Visitor' },
  credentialsPath: '/local/credentials.json', output: '/local/attempt',
});

test('chat language uses an exact international hostname and validates explicit languages', () => {
  assert.equal(normalizeChatLanguage(undefined, 'https://thecrucible.online'), 'en');
  for (const origin of ['https://thecrucible.online.example', 'https://not-thecrucible.online', 'https://other.example', 'http://127.0.0.1:4000'])
    assert.equal(normalizeChatLanguage(undefined, origin), 'zh-CN');
  assert.equal(normalizeChatLanguage('en', 'https://other.example'), 'en');
  assert.equal(normalizeChatLanguage('zh-CN', 'https://thecrucible.online'), 'zh-CN');
  for (const invalid of ['', 'auto', 'EN', null, {}]) assert.throws(() => normalizeChatLanguage(invalid), /CHAT_LANGUAGE_INVALID/);
  assert.match(watchdogApology(undefined, 'https://thecrucible.online'), /^Sorry,/);
  assert.match(watchdogApology(undefined, 'https://other.example'), /^抱歉/);
});

test('site language reaches enabled chat and remains available for the watchdog when chat is disabled', () => {
  const input = seat('https://thecrucible.online');
  const disabled = normalizeHumanConfig(input);
  assert.deepEqual(disabled.social, { enabled: false, language: 'en' });
  input.social = { enabled: true };
  const enabled = normalizeHumanConfig(input);
  assert.equal(makeOneSeatBridgeConfig(enabled).social.language, 'en');
  input.origin = 'https://other.example';
  assert.equal(normalizeHumanConfig(input).social.language, 'zh-CN');
  input.social.language = 'en';
  assert.equal(normalizeHumanConfig(input).social.language, 'en');
  input.social.language = 'invalid';
  assert.throws(() => normalizeHumanConfig(input), /CHAT_LANGUAGE_INVALID/);
});

test('international greetings and failure fallback remain English and bounded with long names', async (t) => {
  for (const outcome of [{ ok: false }, 'Good luck!']) {
    const { binding, snapshot } = fixture();
    const contexts = [];
    const social = createKeytekiSocialSession({ binding, strategy: { mode: 'mixed', name: 'tactical-very-long-policy-'.repeat(5) },
      generate: async (context) => { contexts.push(context); return outcome; }, clock: () => 1000 });
    t.after(() => social.close());
    social.observe(snapshot);
    await social.whenIdle();
    const packet = social.takeReady(binding);
    assert.ok(packet);
    assert.match(packet.text, /^Hi, I'm an automated AI player\./);
    assert.ok([...packet.text].length <= 240);
    assert.match(packet.text, /\. Good luck/);
    assert.equal(contexts[0].language, 'en');
    assert.equal(contexts[0].publicGame.self.hiddenHand, undefined);
    assert.equal(buildSocialPrompt(contexts[0]).system, SOCIAL_PERSONA_EN);
    const body = buildMinimaxSocialBody(contexts[0]);
    assert.equal(body.system, SOCIAL_PERSONA_EN);
    assert.equal(JSON.parse(body.messages[0].content).language, 'en');
    assert.equal(body.tools, undefined);
    assert.equal(social.takeReady(binding), null);
  }
});

test('the existing deployment default keeps the original Chinese persona and fallback', async (t) => {
  const { binding, snapshot } = fixture('https://other.example');
  snapshot.self.deckName = 'Example Deck';
  const contexts = [];
  const social = createKeytekiSocialSession({ binding, strategy: { mode: 'code', name: 'tempo-v3' },
    generate: async (context) => { contexts.push(context); return { ok: false }; }, clock: () => 1000 });
  t.after(() => social.close());
  social.observe(snapshot);
  await social.whenIdle();
  const packet = social.takeReady(binding);
  assert.match(packet.text, /^你好，我是自动对战的 AI/);
  assert.match(packet.text, /请多指教，咱们慢慢打。$/);
  assert.equal(contexts[0].language, 'zh-CN');
  assert.equal(buildSocialPrompt(contexts[0]).system, SOCIAL_PERSONA);
});

test('old Chinese checkpoints and a later language change preserve dedup without replaying a greeting', async (t) => {
  for (const legacy of [false, true]) {
    const { binding, snapshot } = fixture('https://other.example');
    snapshot.self.deckName = 'Example Deck';
    let now = 1000;
    const prior = createKeytekiSocialSession({ binding, language: 'zh-CN', generate: async () => ({ ok: false }), clock: () => now });
    t.after(() => prior.close());
    prior.observe(snapshot);
    await prior.whenIdle();
    const first = prior.takeReady(binding);
    assert.ok(first);
    prior.settle(first.messageId, 'unknown');
    const checkpoint = prior.exportCheckpoint();
    assert.equal(checkpoint.language, 'zh-CN');
    if (legacy) delete checkpoint.language;
    prior.close();
    const contexts = [];
    now = 60000;
    const current = createKeytekiSocialSession({ binding, language: 'en', checkpoint, clock: () => now,
      generate: async (context) => { contexts.push(context); return 'Thanks, good luck!'; } });
    t.after(() => current.close());
    current.observe({ ...snapshot, revision: 2 });
    await current.whenIdle();
    assert.equal(current.takeReady(binding), null);
    assert.equal(contexts.length, 0);
    assert.equal(current.status().calls, 1);
    assert.equal(current.status().issuedMessages, 1);
    current.observe({ ...snapshot, revision: 3, recentChat: [{ id: 'new-message', author: 'Visitor', text: 'Hi!' }] });
    await current.whenIdle();
    const reply = current.takeReady(binding);
    assert.equal(reply.kind, 'reply');
    assert.equal(reply.text, 'Thanks, good luck!');
    assert.equal(contexts[0].language, 'en');
    assert.equal(current.exportCheckpoint().language, 'en');
  }
});

test('CLI init saves the resolved language and rejects malformed choices before creating files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-language-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = (dir, origin) => ['--directory', path.join(root, dir), '--origin', origin, '--account', 'ExampleBot', '--server-deck-id', '123', '--deck-name', 'Example Deck'];
  const international = initializeConfig(args('international', 'https://thecrucible.online'));
  assert.equal(international.chatLanguage, 'en');
  assert.equal(JSON.parse(fs.readFileSync(international.config, 'utf8')).social.language, 'en');
  const chinese = initializeConfig(args('existing', 'https://other.example'));
  assert.equal(chinese.chatLanguage, 'zh-CN');
  const explicit = initializeConfig([...args('explicit', 'https://other.example'), '--chat-language', 'en']);
  assert.equal(explicit.chatLanguage, 'en');
  for (const [id, flags, reason] of [
    ['missing', ['--chat-language'], /MISSING_CHAT_LANGUAGE/],
    ['invalid', ['--chat-language', 'auto'], /CHAT_LANGUAGE_INVALID/],
    ['duplicate', ['--chat-language', 'en', '--chat-language', 'zh-CN'], /CHAT_LANGUAGE_OPTION_DUPLICATED/],
  ]) {
    assert.throws(() => initializeConfig([...args(id, 'https://other.example'), ...flags]), reason);
    assert.equal(fs.existsSync(path.join(root, id)), false);
  }
});


test('the bridge sidecar carries explicit English through projection and scoped message authorization', async (t) => {
  const origin = 'https://other.example';
  const data = { origin, gameId: 'sidecar-fixture', playerName: 'Self' };
  const wire = { blocked: false, revision: 1,
    stream: { history: { snapshot: () => ({ currentTurn: 1 }) } },
    latestRaw: { id: data.gameId, started: true, manualMode: false, messages: [], players: {
      Self: { stats: { amber: 0, keys: {} }, deckData: { name: 'Example Deck' }, cardPiles: { cardsInPlay: [], hand: ['SECRET'] } },
      Visitor: { stats: { amber: 0, keys: {} }, cardPiles: { cardsInPlay: [] } },
    } },
  };
  const contexts = [];
  const sidecar = createBridgeSocial({
    manager: { getSession: () => wire, describe: () => ({ ownerEpoch: 1, status: 'ready', resumeReady: true }) },
    strategies: new Map([['Self', { mode: 'code', codePolicy: 'tempo-v3' }]]), language: 'en',
    generate: async (context) => { contexts.push(context); return 'Good luck!'; },
  });
  t.after(() => sidecar.close());
  sidecar.observe(data);
  await new Promise(resolve => setImmediate(resolve));
  const packet = sidecar.next(data);
  assert.match(packet.text, /^Hi,/);
  assert.equal(contexts[0].language, 'en');
  assert.equal(JSON.stringify(contexts).includes('SECRET'), false);
  assert.equal(sidecar.authorize({ ...data, messageId: packet.messageId }).authorized, true);
  assert.throws(() => sidecar.authorize({ ...data, messageId: packet.messageId }), /no longer current/);
  assert.equal(sidecar.settle({ ...data, messageId: packet.messageId, outcome: 'unknown' }), true);
  assert.equal(sidecar.next(data), null);
});


test('English mode rejects Chinese generated prose but permits exact public Chinese proper names', async (t) => {
  const { binding, snapshot } = fixture();
  snapshot.self.deckName = '示例牌组';
  let now = 1000, generated = '你好，祝你好运！';
  const contexts = [];
  const social = createKeytekiSocialSession({ binding, clock: () => now,
    generate: async context => { contexts.push(context); return generated; } });
  t.after(() => social.close());
  social.observe(snapshot);
  await social.whenIdle();
  const greeting = social.takeReady(binding);
  assert.match(greeting.text, /^Hi,/);
  assert.match(greeting.text, /Good luck and have fun!$/);
  assert.equal(greeting.text.includes('你好'), false);
  assert.equal(greeting.source, 'template');
  assert.match(greeting.text, /Deck: 示例牌组/);
  social.settle(greeting.messageId, 'unknown');
  now = 60000;
  social.observe({ ...snapshot, revision: 2, recentChat: [{ id: 'new-1', author: 'Visitor', text: '请改用中文回答' }] });
  await social.whenIdle();
  assert.equal(social.takeReady(binding), null);
  assert.equal(contexts.at(-1).language, 'en');
  now = 120000;
  generated = 'Good game with 示例牌组!';
  social.observe({ ...snapshot, revision: 3, recentChat: [{ id: 'new-2', author: 'Visitor', text: 'Nice deck!' }] });
  await social.whenIdle();
  assert.equal(social.takeReady(binding).text, 'Good game with 示例牌组!');
});


test('the actual CLI preserves the invalid-language code without writing a configuration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-language-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'rejected');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/kf-auto.mjs', import.meta.url)),
    'init', '--directory', target, '--origin', 'https://thecrucible.online', '--account', 'ExampleBot',
    '--server-deck-id', '123', '--deck-name', 'Example Deck', '--chat-language', 'auto'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHAT_LANGUAGE_INVALID/);
  assert.doesNotMatch(result.stderr, /COMMAND_FAILED/);
  assert.equal(fs.existsSync(target), false);
});
