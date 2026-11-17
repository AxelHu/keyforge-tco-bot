#!/usr/bin/env node
/** Optional real Chromium check of local DOM fixtures, never a live TCO login or game.
 * The fixtures reproduce the observed names and field structure, not the remote React application.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentBrowser, inspectBrowserProcess, browserProcessDisposition,
} from '../tools/browser-provider.mjs';
import { browserRecordPath } from '../tools/browser-paths.mjs';
import { keytekiUiButton, keytekiUiName } from '../tools/keyteki-ui-contract.mjs';
import {
  PublicRoomObserver,
  createPublicRoomUi,
  selectOwnDeckUi,
  leaveUnjoinedOwnRoomUi,
  startOwnBoundRoomUi,
} from '../tools/keyteki-human-public-room-ui.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyforge-tco-international-ui-smoke-'));
process.env.KF_BOT_BROWSER_REGISTRY = path.join(directory, 'registry');
const profileDir = path.join(directory, 'profile');
const pool = new AgentBrowser({ keepAlive: false, cleanupOnExit: false });
const origin = 'https://tco-ui-fixture.invalid';
const gameId = 'fixture-room-1', own = 'Fixture Bot', other = 'Fixture Human';
const frame = (...args) => '42' + JSON.stringify(args);
const config = {
  origin,
  createPublic: true,
  setupTimeoutMs: 5000,
  self: { name: own, deckName: 'Fixture Deck', serverDeckId: 23 },
  ownAccountNames: [own],
  participants: [own],
  room: { gameId: null, name: 'Fixture room', gameType: 'beginner', gameFormat: 'normal' },
};
const publicRoom = (names = [own], owner = own) => ({
  id: gameId, name: config.room.name, started: false, gamePrivate: false, needsPassword: false,
  gameType: config.room.gameType, gameFormat: 'normal', owner,
  players: Object.fromEntries(names.map(name => [name, {
    name, id: name === own ? 'fixture-own-socket' : 'fixture-other-socket',
    deck: { selected: false, name: name === own ? config.self.deckName : 'Other Fixture Deck' },
  }])),
});
// Independent observed captions: never derive the fixture DOM from the implementation under test.
const FIXTURE_CAPTIONS = {
  en: { newGame: 'New Game', start: 'Start', join: 'Join', leavePending: 'Leave', leaveFinished: 'Leave Game', allowSpectators: 'Allow spectators' },
  zh: { newGame: '新游戏', start: '开始', join: '加入', leavePending: '离开', leaveFinished: '离开游戏', allowSpectators: '允许观战' },
};
const checks = {}, fixtureCommands = [];
let complete = false, failure, binding, observer, currentRaw, currentPhase;
let externalRequestsBlocked = 0;
async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function fixtureHtml(locale, initiallySelectedType = 'casual') {
  const label = key => FIXTURE_CAPTIONS[locale][key];
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>Local UI contract fixture</title>
  <body><p>Local synthetic component fixture only. No remote login or game.</p>
  <a href="/play" onclick="event.preventDefault()">Play</a>
  <button type="button" id="new-game">${label('newGame')}</button>
  <button type="button">Quick Join</button><button type="button">New Game now</button>
  <label><input type="checkbox" id="beginner">Beginner lobby filter</label>
  <form id="creation" hidden>
    <input id="name" name="name" type="text">
    <label><input type="radio" name="gameType" value="casual" ${initiallySelectedType === 'casual' ? 'checked' : ''}>Casual</label>
    <label><input type="radio" name="gameType" value="beginner" ${initiallySelectedType === 'beginner' ? 'checked' : ''}>Beginner</label>
    <label><input type="radio" name="gameFormat" value="sealed" checked>Sealed</label>
    <label><input type="radio" name="gameFormat" value="normal">Archon</label>
    <label><input type="checkbox" id="gamePrivate" checked>Unlisted (link only)</label>
    <label><input type="checkbox" id="requirePassword" checked>Require password</label>
    <button type="submit">${label('start')}</button>
  </form>
  <section id="pending" hidden>
    <button type="button" id="select-deck">Select deck</button>
    <table id="decks" hidden><tbody>
      <tr data-deck-id="22"><td><input type="checkbox" aria-label="Select row 22"></td><td>Fixture Deck</td></tr>
      <tr data-deck-id="23"><td><input type="checkbox" aria-label="Select row 23"></td><td id="correct-deck">Fixture Deck</td></tr>
    </tbody></table>
    <button type="button" id="leave">${label('leavePending')}</button>
    <button type="button">${label('leaveFinished')}</button><button type="button">Concede</button>
  </section>
  <script>
    document.getElementById('new-game').onclick = () => {
      document.getElementById('new-game').hidden = true;
      document.getElementById('creation').hidden = false;
    };
    document.getElementById('creation').onsubmit = async event => {
      event.preventDefault();
      await window.uiFixtureEvent({
        kind: 'create',
        name: document.getElementById('name').value,
        gameType: document.querySelector('input[name="gameType"]:checked').value,
        gameFormat: document.querySelector('input[name="gameFormat"]:checked').value,
        gamePrivate: document.getElementById('gamePrivate').checked,
        requirePassword: document.getElementById('requirePassword').checked,
        lobbyFilter: document.getElementById('beginner').checked,
      });
      document.getElementById('creation').hidden = true;
      document.getElementById('pending').hidden = false;
    };
    document.getElementById('select-deck').onclick = () => {
      document.getElementById('decks').hidden = false;
    };
    document.querySelectorAll('#decks tr td:last-child').forEach(cell => {
      cell.onclick = async () => {
        await window.uiFixtureEvent({ kind: 'deck', serverDeckId: Number(cell.closest('tr').dataset.deckId) });
        document.getElementById('decks').hidden = true;
        document.getElementById('select-deck').textContent = 'Change deck';
      };
    });
    document.getElementById('leave').onclick = async () => {
      await window.uiFixtureEvent({ kind: 'leave' });
      document.getElementById('pending').hidden = true;
    };
  </script></body></html>`;
}

try {
  const instance = await pool.getBrowser('keyforge-tco-bot:international-ui-smoke', {
    mode: 'per-agent', profileDir, headless: true,
  });
  binding = JSON.parse(fs.readFileSync(browserRecordPath(profileDir), 'utf8')).process;
  const page = instance.page;
  let html = fixtureHtml('en');
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    externalRequestsBlocked++;
    return route.abort();
  });
  await page.exposeFunction('uiFixtureEvent', async event => {
    fixtureCommands.push({ phase: currentPhase, kind: event.kind });
    if (event.kind === 'create') {
      assert.equal(event.name, config.room.name);
      assert.equal(event.gameType, config.room.gameType);
      assert.equal(event.gameFormat, 'normal');
      assert.equal(event.gamePrivate, false);
      assert.equal(event.requirePassword, false);
      assert.equal(event.lobbyFilter, false);
      assert.equal(observer.creationRequested, true);
      currentRaw = publicRoom();
      observer.ingest(frame('gamestate', currentRaw));
    } else if (event.kind === 'deck') {
      assert.equal(event.serverDeckId, config.self.serverDeckId);
      observer.ingest(frame('selectdeck', gameId, event.serverDeckId, false), true);
      currentRaw.players[own].deck.selected = true;
      observer.ingest(frame('gamestate', currentRaw));
    } else if (event.kind === 'leave') {
      assert.equal(observer.leaveRequested, true);
      observer.ingest(frame('leavegame', gameId), true);
      assert.equal(observer.serverLeaveReceipt, null);
      observer.ingest(frame('cleargamestate'));
    } else if (event.kind === 'start') {
      currentRaw.started = true;
      observer.ingest(frame('gamestate', currentRaw));
    } else {
      throw Error('UNEXPECTED_FIXTURE_EVENT');
    }
  });

  for (const locale of ['en', 'zh']) {
    for (const gameType of ['beginner', 'casual']) {
      currentPhase = locale + '-' + gameType + '-public-create-select-leave';
      config.room.gameType = gameType;
      html = fixtureHtml(locale, gameType === 'casual' ? 'beginner' : 'casual');
      await page.goto(origin + '/play', { waitUntil: 'domcontentloaded' });
      observer = new PublicRoomObserver(page, config);
      await observer.ready;
      observer.ingest('40{"sid":"fixture-own-socket"}');
      const created = await createPublicRoomUi(page, observer, config);
      assert.equal(created.gameId, gameId);
      assert.equal(created.gameType, gameType);
      const selected = await selectOwnDeckUi(page, observer, config);
      assert.equal(selected.serverDeckId, 23);
      assert.equal(selected.commandObserved, true);
      const left = await leaveUnjoinedOwnRoomUi(page, observer, config);
      assert.equal(left.serverLeaveReceipt.gameId, gameId);
      assert.equal(left.serverLeaveReceipt.source, 'cleargamestate');
      assert.equal(left.serverLeaveConfirmed, true);
      assert.deepEqual(fixtureCommands.filter(value => value.phase === currentPhase).map(value => value.kind), ['create', 'deck', 'leave']);
      checks[locale + (gameType === 'casual' ? 'Casual' : '') + 'PublicCreateExactDeckAndNativeLeave'] = true;
      observer.dispose();
      observer = null;
    }
    config.room.gameType = 'beginner';

    currentPhase = locale + '-bound-start';
    const startName = FIXTURE_CAPTIONS[locale].start;
    await page.setContent(`<button type="button" id="start" disabled>${startName}</button><button type="button">Restart</button>
      <script>document.getElementById('start').onclick = async () => {
        await window.uiFixtureEvent({kind:'start'}); window.fixtureStarted = true;
      };</script>`);
    const boundConfig = { ...config, createPublic: false, participants: [own, other], room: { ...config.room, gameId, opponentName: other } };
    observer = new PublicRoomObserver(page, boundConfig);
    await observer.ready;
    observer.joinRequested = true;
    observer.ingest('40{"sid":"fixture-own-socket"}');
    currentRaw = publicRoom([own, other]);
    for (const player of Object.values(currentRaw.players)) player.deck.selected = true;
    observer.ingest(frame('gamestate', currentRaw));
    await assert.rejects(startOwnBoundRoomUi(page, observer, boundConfig), { code: 'BOUND_HOST_START_NOT_READY' });
    assert.equal(fixtureCommands.filter(value => value.phase === currentPhase).length, 0);
    await page.locator('#start').evaluate(element => { element.disabled = false; });
    assert.equal((await startOwnBoundRoomUi(page, observer, boundConfig)).clicked, true);
    await page.waitForFunction(() => window.fixtureStarted === true, null, { timeout: 5000 });
    assert.equal(observer.active, true);
    assert.equal(fixtureCommands.filter(value => value.phase === currentPhase).length, 1);
    checks[locale + 'BoundStartKeepsDisabledGuard'] = true;
    observer.dispose();
    observer = null;

    const name = key => FIXTURE_CAPTIONS[locale][key];
    await page.setContent(`<button id="pending">${name('leavePending')}</button>
      <button id="finished">${name('leaveFinished')}</button><button id="concede">Concede</button>
      <button>Leave Game now</button><button id="join">${name('join')}</button><button>Join another game</button>
      <label><input type="checkbox" id="allowSpectators">${name('allowSpectators')}</label>
      <script>window.clicked=[];document.querySelectorAll('button').forEach(button => button.onclick=()=>window.clicked.push(button.id));</script>`);
    await keytekiUiButton(page, 'leaveFinished').click();
    await keytekiUiButton(page, 'join').click();
    assert.deepEqual(await page.evaluate(() => window.clicked), ['finished', 'join']);
    await page.getByText(keytekiUiName('allowSpectators'), { exact: true }).click();
    assert.equal(await page.locator('#allowSpectators').isChecked(), true);
    checks[locale + 'FinishedLeaveJoinAndSpectatorsStayExact'] = true;
  }

  await page.setContent('<button>Start</button><button>开始</button><button>Restart</button>');
  assert.equal(await keytekiUiButton(page, 'start').count(), 2);
  await assert.rejects(keytekiUiButton(page, 'start').click({ timeout: 1000 }), error => /strict mode violation/.test(error.message));
  checks.ambiguousBilingualControlsAreRejected = true;
  complete = true;
} catch (error) {
  failure = error;
} finally {
  observer?.dispose();
  const errors = [];
  try {
    await within(pool.closeAll(), 22000, 'UI_SMOKE_BROWSER_CLEANUP_TIMEOUT');
    if (binding) assert.equal(browserProcessDisposition(binding, inspectBrowserProcess(binding.pid)), 'gone');
    assert.equal(fs.existsSync(browserRecordPath(profileDir)), false);
    checks.ownedBrowserExitAndLeaseReleaseConfirmed = true;
  } catch (error) { errors.push(error); }
  if (complete && !failure && !errors.length) fs.rmSync(directory, { recursive: true, force: true });
  else {
    console.error(JSON.stringify({ retainedDiagnosticDirectory: directory }));
    throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Local international UI contract smoke failed');
  }
}

console.log(JSON.stringify({
  schema: 'keyforge-tco-international-ui-smoke-v1',
  result: 'passed',
  evidenceKind: 'real Chromium with local synthetic DOM and native-message fixtures',
  remoteAuthenticatedUiVerified: false,
  checks,
  fixtureCommands,
  externalRequestsBlocked,
  chromiumSandbox: process.env.KF_BOT_NO_SANDBOX !== '1',
  liveLoginAttempts: 0,
  liveRoomsCreated: 0,
  liveGamesStarted: 0,
  liveMessagesSent: 0,
  temporaryProfileRemoved: !fs.existsSync(directory),
}, null, 2));
