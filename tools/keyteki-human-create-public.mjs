import { browserNetworkArgs } from './browser-network.mjs';
/** Review draft: normal public-room UI preparation, then the same one-seat controller. */
import fs from 'node:fs';
import path from 'node:path';
import { humanBrowserAgentId } from './browser-paths.mjs';
import { BROWSER_MODULE, humanPreflight, normalizeHumanConfig, fail } from './keyteki-human-config.mjs';
import {
  PublicRoomObserver,
  createPublicRoomUi,
  selectOwnDeckUi,
  leaveUnjoinedOwnRoomUi,
} from './keyteki-human-public-room-ui.mjs';
import { readOwnCredentials, runOneSeat } from './keyteki-human-launcher.mjs';
import { pendingGameSocketBootstrap } from './keyteki-human-bridge-callback.mjs';
import { releaseOwnedHumanBrowser } from './keyteki-owned-browser-release.mjs';

export function lockCreatedPublicPair(input, observer) {
  observer.assertHealthy();
  const pending = observer.pending,
    opponentName = observer.candidateName;
  if (
    !observer.config.createPublic ||
    observer.active ||
    !pending ||
    !opponentName ||
    pending.participants.length !== 2 ||
    !pending.participants.includes(opponentName) ||
    observer.config.ownAccountNames.includes(opponentName) ||
    pending.owner !== observer.config.self.name ||
    !pending.ownSelected ||
    pending.ownDeckName !== observer.config.self.deckName ||
    !observer.selection ||
    Number(observer.selection.serverDeckId) !== observer.config.self.serverDeckId ||
    observer.selection.isStandalone !== false ||
    observer.selection.gameId !== pending.gameId
  )
    fail('CREATED_PAIR_NOT_READY_TO_LOCK');
  const boundInput = { ...input, room: { ...input.room, gameId: pending.gameId, opponentName } };
  const config = normalizeHumanConfig(boundInput);
  // Retain the existing observer/listeners on the one lobby connection. From here, names
  // are immutable for this game; a departure/replacement never silently chooses a new opponent.
  observer.config = config;
  observer.joinRequested = true;
  return { input: boundInput, config };
}

export async function runCreatePublic(input, { onEvidence } = {}) {
  const preflight = humanPreflight(input, { createPublic: true }),
    config = preflight.config;
  if (!preflight.report.readyForExplicitRun) fail('OFFLINE_PREFLIGHT_INCOMPLETE');
  const [{ AgentBrowser }, ui, policies] = await Promise.all([
    import(BROWSER_MODULE),
    import('./keyteki-fuzhou-ui.mjs'),
    import('../dist/src/ai/code-strategies.js'),
  ]);
  if (!policies.CODE_POLICY_IDS.includes(config.self.codePolicy)) fail('CODE_POLICY_UNAVAILABLE');
  fs.mkdirSync(config.output, { mode: 0o700 });
  const write = (name, value) => {
    const dest = path.join(config.output, name),
      temp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, dest);
  };
  write('preflight.json', preflight.report);
  let pool, instance, observer, setup, preparePlayerInFlight = false;
  const state = {
    schema: 'keyteki-public-room-preparation-v1',
    phase: 'opening-own-page',
    controlledAccounts: [config.self.name],
    publicRoomName: config.room.name,
    gameId: null,
    participants: [config.self.name],
    held: false,
    finishedNoOpponent: false,
    hostStarted: false,
    gameStarted: false,
    createdAt: new Date().toISOString(),
  };
  const save = () =>
    write('handoff.json', {
      ...state,
      updatedAt: new Date().toISOString(),
      driverPid: process.pid,
      browserProfile: config.browserProfile,
      network: config.network,
      ...(instance
        ? { agentId: instance.agentId, cdpEndpoint: instance.cdpEndpoint, pageUrl: instance.page.url() }
        : {}),
      note: 'Preparation only until the observed pair is locked. Preserve this browser if any opponent or uncertainty exists.',
    });
  const hold = async (code) => {
    if (state.held) return;
    state.held = true;
    state.phase = 'held-for-inspection';
    state.holdReason = /^[A-Z0-9_-]{1,100}$/i.test(code ?? '') ? code : 'PUBLIC_ROOM_PREPARATION_UNVERIFIED';
    save();
    console.log(
      JSON.stringify({
        event: 'public-preparation-held',
        reason: state.holdReason,
        handoff: path.join(config.output, 'handoff.json'),
        browserPreserved: true,
        hostStarted: false,
      }),
    );
  };
  const healthy = () => {
    if (state.held) fail('PREPARATION_ALREADY_HELD');
    observer?.assertHealthy();
  };
  const signal = () => {
    void hold('OPERATOR_SIGNAL_PRESERVED');
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  const removeSignals = () => {
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
  };
  try {
    pool = new AgentBrowser({
      keepAlive: true,
      cleanupOnExit: false,
      extraArgs: browserNetworkArgs(config.network),
    });
    instance = await pool.getBrowser(humanBrowserAgentId(config.output), {
      mode: 'per-agent',
      profileDir: config.browserProfile,
      inherit: false,
      headless: config.headless,
    });
    await instance.page.addInitScript({ content: pendingGameSocketBootstrap(config.origin) });
    observer = new PublicRoomObserver(instance.page, config);
    state.phase = 'login-own-account';
    save();
    setup = ui.createFuzhouUiSetup({
      origin: config.origin,
      gameType: config.room.gameType,
      timeoutMs: config.setupTimeoutMs,
    });
    preparePlayerInFlight = true;
    await setup.preparePlayer({
      page: instance.page,
      player: config.self,
      credentials: readOwnCredentials(config),
      origin: config.origin,
    });
    preparePlayerInFlight = false;
    healthy();
    state.phase = 'create-public-' + config.room.gameType + '-room';
    save();
    const room = await createPublicRoomUi(instance.page, observer, config);
    state.gameId = room.gameId;
    write('created-room-receipt.json', room);
    healthy();
    state.phase = 'select-own-deck';
    save();
    const deck = await selectOwnDeckUi(instance.page, observer, config);
    write('own-deck-selection.json', deck);
    healthy();
    state.phase = 'waiting-for-one-external-opponent';
    const deadline = Date.now() + config.waitForOpponentMs;
    state.waitStartedAt = new Date().toISOString();
    state.waitDeadline = new Date(deadline).toISOString();
    save();
    while (!observer.candidateName && Date.now() < deadline) {
      healthy();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    healthy();
    if (!observer.candidateName) {
      // There has been no game transport, bridge, paid chat, or started game. A current
      // native own-only pending receipt is required again immediately before the UI click.
      const cleanup = await leaveUnjoinedOwnRoomUi(instance.page, observer, config);
      write('no-opponent.json', {
        status: 'no-opponent',
        ...cleanup,
        waitForOpponentMs: config.waitForOpponentMs,
        waitStartedAt: state.waitStartedAt,
        completedAt: new Date().toISOString(),
        controlledAccounts: [config.self.name],
        bridgeStarted: false,
        gameStarted: false,
        aiChatRequested: false,
      });
      if (cleanup.serverLeaveConfirmed !== true) fail('EMPTY_ROOM_SERVER_LEAVE_UNCONFIRMED');
      healthy();
      await releaseOwnedHumanBrowser({ pool, instance, config });
      state.runtimeRetired = true;
      state.finishedNoOpponent = true;
      state.phase = 'no-opponent';
      save();
      observer.dispose();
      removeSignals();
      console.log(
        JSON.stringify({
          event: 'no-opponent',
          gameId: state.gameId,
          normalUiLeaveConfirmed: true,
          receipt: path.join(config.output, 'no-opponent.json'),
        }),
      );
      return { config, state, pool, instance, hold, save };
    }
    const bound = lockCreatedPublicPair(input, observer);
    write('locked-public-pair.json', {
      gameId: bound.config.room.gameId,
      participants: bound.config.participants,
      controlledAccounts: [config.self.name],
      origin: config.origin,
      roomName: config.room.name,
      public: true,
      requiresPassword: false,
      publicRuleContracts: [],
      nativePendingObserved: true,
      ownDeckCommandObserved: true,
      lockedAt: new Date().toISOString(),
    });
    state.participants = bound.config.participants;
    state.phase = 'locked-pair-starting-one-seat-host';
    save();
    // Host configuration does not exist until native evidence has supplied the exact pair.
    // The one-seat routine reuses this page, installs before the game transport starts,
    // waits for both deck selections, and uses the observed normal Start control.
    removeSignals();
    return await runOneSeat(bound.input, { output: config.output, pool, instance, observer }, { onEvidence });
  } catch (error) {
    if (preparePlayerInFlight) {
      const failure = setup?.getPreparePlayerFailure();
      if (failure) state.setupFailure = failure;
    }
    await hold(error?.code ?? 'PUBLIC_ROOM_PREPARATION_UNVERIFIED');
    return { config, state, pool, instance, hold, save };
  }
}
