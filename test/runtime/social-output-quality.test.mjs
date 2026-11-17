import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeytekiSocialSession, normalizeSocialText } from '../../tools/keyteki-social-session.mjs';
import { createMinimaxSocialProvider, MINIMAX_SOCIAL_MODEL } from '../../tools/minimax-social-provider.mjs';

const fixture = (language = 'en') => {
  const binding = { origin: language === 'en' ? 'https://thecrucible.online' : 'http://kf.example.test:4000',
    gameId: 'social-quality-fixture', playerName: 'Self', opponentName: 'Visitor', ownerEpoch: '1' };
  return { binding, snapshot: { ...binding, revision: 1, turn: 1, ready: true, started: true, finished: false,
    self: { keys: 0, amber: 0, keyCost: 6, creatures: 0, readyCreatures: 0, deckName: '示例牌组' },
    opponent: { keys: 0, amber: 0, keyCost: 6, creatures: 0, readyCreatures: 0 }, recentChat: [] } };
};

function mockProvider(output) {
  let requests = 0;
  const receipts = [];
  const provider = createMinimaxSocialProvider({
    apiKey: 'sk-cp-offline-social-quality-fixture',
    onReceipt: receipt => receipts.push(receipt),
    fetcher: async (_url, init) => {
      const context = JSON.parse(JSON.parse(init.body).messages[0].content);
      requests++;
      const text = typeof output === 'function' ? output(context) : output;
      return new Response(JSON.stringify({ type: 'message', role: 'assistant', id: `offline-${requests}`,
        model: MINIMAX_SOCIAL_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }],
        usage: { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { provider, receipts, requests: () => requests };
}

const directContext = { language: 'en', reason: { type: 'reply' }, publicGame: {
  self: { name: 'Self' }, opponent: { name: 'Visitor' }, strategy: { mode: 'code', name: 'fixture' } }, recentChat: [] };

test('empty-string literals and punctuation-only content cannot become outgoing chat', () => {
  for (const text of ['""', "''", '“”', '「  」', '…', '...', '— —', '‼', '⁉', '‼️', '〰', '***', '[]', '{}', '+ = < >', '#', '*', '#\uFE0F', '*\uFE0F', '\u20E3', '\uFE0F\u20E3', '\uFE0F', '\u0301'])
    assert.equal(normalizeSocialText(text), null, JSON.stringify(text));
  for (const text of ['', ' \t\n ']) assert.equal(normalizeSocialText(text), '');
  for (const text of ['/draw', '!end', '\u200bgg', '```gg```', '<analysis>hidden</analysis>', 'a'.repeat(241)])
    assert.equal(normalizeSocialText(text), null, JSON.stringify(text));
});

test('normal short text, scores, proper names and existing emoji replies remain valid', () => {
  for (const text of ['gg', 'GL HF!', '好', '你好！', '3:2', '“Good game!”', 'Nice 示例牌组!', 'Æmber is close.',
    '👍', '🙂', '🗝️', '❤️', '🇨🇳', '#️⃣', '*️⃣', '#⃣', '*⃣', 'Nice! 👍'])
    assert.equal(normalizeSocialText(text), text);
  // Keep the pre-existing invisible-character restriction; this change does not relax it for ZWJ emoji.
  assert.equal(normalizeSocialText('👩\u200d💻'), null);
});

test('the real provider parser rejects the observed double-quote output without retrying or losing usage', async () => {
  for (const output of ['""', '...', '— —']) {
    const mock = mockProvider(output);
    const result = await mock.provider.generate(directContext);
    assert.equal(result.ok, false);
    assert.equal(result.text, undefined);
    assert.equal(result.receipt.reason, 'invalid-chat-text');
    assert.equal(result.receipt.paidAttempt, true);
    assert.equal(result.receipt.usage.totalTokens, 14);
    assert.equal(mock.requests(), 1);
    assert.equal(mock.receipts.length, 1);
    assert.equal(mock.receipts[0].accepted, false);
  }
});

test('an intentional blank remains a successful silent provider result', async () => {
  const mock = mockProvider(' \t\n ');
  const result = await mock.provider.generate(directContext);
  assert.equal(result.ok, true);
  assert.equal(result.text, '');
  assert.equal(result.receipt.finalBytes, 0);
  assert.equal(mock.requests(), 1);
});

test('invalid or silent greetings use one existing language template and are never replayed', async (t) => {
  for (const language of ['en', 'zh-CN']) for (const output of ['""', '...', ' \t\n ']) {
    const { binding, snapshot } = fixture(language);
    const mock = mockProvider(output);
    let now = 1000;
    const social = createKeytekiSocialSession({ binding, language, clock: () => now, generate: mock.provider.generate });
    t.after(() => social.close());
    social.observe(snapshot);
    await social.whenIdle();
    const greeting = social.takeReady(binding);
    assert.ok(greeting);
    assert.equal(greeting.source, 'template');
    assert.match(greeting.text, language === 'en' ? /^Hi, I'm an automated AI player\./ : /^你好，我是自动对战的 AI/);
    assert.match(greeting.text, language === 'en' ? /Good luck and have fun!$/ : /请多指教，咱们慢慢打。$/);
    assert.equal(social.settle(greeting.messageId, 'unknown'), true);
    now = 60000;
    social.observe({ ...snapshot, revision: 2 });
    await social.whenIdle();
    assert.equal(social.takeReady(binding), null);
    assert.equal(mock.requests(), 1);
    assert.equal(social.status().calls, 1);
    assert.equal(social.status().issuedMessages, 1);
    const checkpoint = social.exportCheckpoint();
    social.close();
    const recovered = createKeytekiSocialSession({ binding, language, checkpoint, clock: () => now, generate: mock.provider.generate });
    t.after(() => recovered.close());
    recovered.observe({ ...snapshot, revision: 3 });
    await recovered.whenIdle();
    assert.equal(recovered.takeReady(binding), null);
    assert.equal(mock.requests(), 1);
  }
});

test('contentless replies and milestones are consumed once without queued messages or extra paid calls', async (t) => {
  for (const kind of ['reply', 'key', 'game_end']) for (const output of ['""', '...', ' \t\n ']) {
    const { binding, snapshot } = fixture();
    const mock = mockProvider(context => context.reason.type === 'greeting' ? 'Good luck!' : output);
    const events = [];
    let now = 1000;
    const social = createKeytekiSocialSession({ binding, clock: () => now, generate: mock.provider.generate,
      onEvent: event => events.push(event) });
    t.after(() => social.close());
    social.observe(snapshot);
    await social.whenIdle();
    const greeting = social.takeReady(binding);
    assert.equal(greeting.source, 'model');
    social.settle(greeting.messageId, 'confirmed');
    now = 60000;
    const next = { ...snapshot, revision: 2,
      ...(kind === 'reply' ? { recentChat: [{ id: 'question-1', author: 'Visitor', text: 'Nice deck!' }] } : {}),
      ...(kind === 'key' ? { self: { ...snapshot.self, keys: 1 } } : {}),
      ...(kind === 'game_end' ? { finished: true, winnerName: 'Visitor' } : {}),
    };
    social.observe(next);
    await social.whenIdle();
    assert.equal(social.takeReady(binding), null);
    assert.equal(mock.requests(), 2);
    assert.equal(mock.receipts.length, 2);
    assert.equal(social.status().issuedMessages, 1);
    assert.ok(events.some(event => event.type === 'generation-discarded' && event.kind === kind));
    now = 120000;
    social.observe({ ...next, revision: 3 });
    social.tick();
    await social.whenIdle();
    assert.equal(social.takeReady(binding), null);
    assert.equal(mock.requests(), 2);
    const checkpoint = social.exportCheckpoint();
    social.close();
    const recovered = createKeytekiSocialSession({ binding, checkpoint, clock: () => now, generate: mock.provider.generate });
    t.after(() => recovered.close());
    recovered.observe({ ...next, revision: 4 });
    await recovered.whenIdle();
    assert.equal(recovered.takeReady(binding), null);
    assert.equal(mock.requests(), 2);
  }
});

test('short English and Chinese replies, public names and emoji still traverse the production session', async (t) => {
  for (const [language, reply] of [['en', 'gg'], ['en', 'Nice 示例牌组!'], ['en', '👍'], ['en', '#️⃣'], ['en', '*️⃣'], ['en', '#⃣'], ['en', '*⃣'], ['zh-CN', '好'], ['zh-CN', '赞，示例牌组不错！']]) {
    const { binding, snapshot } = fixture(language);
    let now = 1000, calls = 0;
    const social = createKeytekiSocialSession({ binding, language, clock: () => now,
      generate: async context => { calls++; return context.reason.type === 'greeting' ? 'Good luck!' : reply; } });
    t.after(() => social.close());
    social.observe(snapshot);
    await social.whenIdle();
    const greeting = social.takeReady(binding);
    social.settle(greeting.messageId, 'confirmed');
    now = 60000;
    social.observe({ ...snapshot, revision: 2, recentChat: [{ id: 'message-1', author: 'Visitor', text: 'Hello!' }] });
    await social.whenIdle();
    const packet = social.takeReady(binding);
    assert.equal(packet.kind, 'reply');
    assert.equal(packet.source, 'model');
    assert.equal(packet.text, reply);
    assert.equal(calls, 2);
  }
});
