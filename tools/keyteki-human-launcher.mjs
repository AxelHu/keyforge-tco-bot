#!/usr/bin/env node
import { browserNetworkArgs } from './browser-network.mjs';
/** Review draft. Default CLI is offline plan; --run is the only entry that can login/join. */
import fs from 'node:fs';
import path from 'node:path';
import { humanBrowserAgentId } from './browser-paths.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  BROWSER_MODULE,
  humanPreflight,
  makeOneSeatBridgeConfig,
  fail,
} from './keyteki-human-config.mjs';
import {
  PublicRoomObserver,
  joinObservedPublicRoom,
  selectOwnDeckUi,
  waitForObserved,
  startOwnBoundRoomUi,
} from './keyteki-human-public-room-ui.mjs';
import { createOneSeatBridgeBinding, managedHumanBootstrap } from './keyteki-human-bridge-callback.mjs';
import { installHumanWatchdog, createHumanHoldController } from './keyteki-human-watchdog-browser.mjs';
import { installFinishedRoomExit } from './keyteki-finished-room-exit.mjs';
import { installJoinedPendingRoomExit } from './keyteki-joined-pending-exit.mjs';
import { retireCreatedPendingRoom } from './keyteki-created-pending-exit.mjs';
import { stopUnjoinedHost } from './keyteki-unjoined-host-stop.mjs';
import { installDisconnectedOpponentExit } from './keyteki-disconnected-opponent-exit.mjs';
import { stopDisconnectedHost } from './keyteki-disconnected-host-stop.mjs';
import { releaseOwnedHumanBrowser } from './keyteki-owned-browser-release.mjs';
import { hostStopWasRequested, bindRecoveredHostConnection } from './keyteki-host-operator-intent.mjs';
import { retireFinishedHumanRuntime } from './keyteki-finished-runtime-retirement.mjs';
export { checkBoundBridgeRequest, checkOwnFullIdentity } from './keyteki-human-bridge-callback.mjs';

const execute = promisify(execFile);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function readOwnCredentials(config) {
  let value;
  try {
    const stat = fs.statSync(config.credentialsPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail('CREDENTIAL_FILE_NOT_PRIVATE');
    value = JSON.parse(fs.readFileSync(config.credentialsPath, 'utf8'));
  } catch {
    fail('OWN_CREDENTIALS_UNAVAILABLE');
  }
  if (!object(value)) fail('OWN_CREDENTIALS_UNAVAILABLE');
  if (value.origin !== undefined && value.origin !== config.origin) fail('CREDENTIAL_ORIGIN_MISMATCH');
  // Compatible with the existing protected account file, but only this exact own entry is used.
  const own = value.accounts?.[config.self.name];
  if (
    !object(own) ||
    (own.username !== undefined && own.username !== config.self.name) ||
    typeof own.password !== 'string' ||
    !own.password
  )
    fail('OWN_CREDENTIALS_UNAVAILABLE');
  return { username: config.self.name, password: own.password };
}

/** One fixed seat. Authorized own-turn fault fallback is separate from strategy/model decisions. */
export async function runOneSeat(input, prepared = null, { onEvidence } = {}) {
  const preflight = humanPreflight(input),
    config = preflight.config;
  if (!prepared && !preflight.report.readyForExplicitRun) fail('OFFLINE_PREFLIGHT_INCOMPLETE');
  // Native observation also supports normal finish handling when automatic recovery is disabled.
  const observationEnabled = config.watchdog.enabled || config.leaveAfterFinish;
  if (
    prepared &&
    (prepared.output !== config.output ||
      !prepared.instance?.page ||
      !prepared.pool ||
      !(prepared.observer instanceof PublicRoomObserver) ||
      prepared.observer.config.room.gameId !== config.room.gameId ||
      prepared.observer.active ||
      !prepared.observer.joinRequested ||
      !sameNames(prepared.observer.pending?.participants ?? [], config.participants))
  )
    fail('PREPARED_OWN_ROOM_UNVERIFIED');
  const [{ AgentBrowser }, { userscriptBootstrap }, ui, publicTools, wireTools, policies] = await Promise.all(
    [
      import(BROWSER_MODULE),
      import('./keyteki-browser-bootstrap.mjs'),
      import('./keyteki-fuzhou-ui.mjs'),
      import('./keyteki-public-browser-game.mjs'),
      import('./keyteki-wire-session.mjs'),
      import('../dist/src/ai/code-strategies.js'),
    ],
  );
  if (!policies.CODE_POLICY_IDS.includes(config.self.codePolicy)) fail('CODE_POLICY_UNAVAILABLE');
  // The exact public binding helper rejects credentials, extra URL parameters and another game.
  publicTools.publicGameBinding({
    origin: config.origin,
    gameId: config.room.gameId,
    gameUrl: config.gameUrl,
  });
  if (!prepared) fs.mkdirSync(config.output, { mode: 0o700 });
  const write = (name, value) => {
    const dest = path.join(config.output, name),
      temp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, dest);
  };
  write(prepared ? 'bound-preflight.json' : 'preflight.json', preflight.report);
  const bridgeConfigPath = path.join(config.output, 'bridge-config.json');
  write('bridge-config.json', makeOneSeatBridgeConfig(config));
  let connection,
    uiSetup,
    preparePlayerInFlight = false,
    watchdogRuntime,
    finishedExit,
    joinedPendingExit,
    disconnectedExit,
    hostIdentity,
    unjoinedHostBinding,
    instance = prepared?.instance,
    pool = prepared?.pool,
    observer = prepared?.observer;
  const state = {
    schema: 'keyteki-one-controlled-seat-run-v1',
    phase: 'starting-host',
    gameId: config.room.gameId,
    participants: config.participants,
    controlledAccounts: [config.self.name],
    codePolicy: config.self.codePolicy,
    fullVerified: false,
    finished: false,
    held: false,
    bridgeStatus: null,
    finalPublicView: null,
    evidencePerspective: 'only the controlled account native player view',
    createdAt: new Date().toISOString(),
  };
  const handoff = () => {
    write('handoff.json', {
      ...state,
      updatedAt: new Date().toISOString(),
      driverPid: process.pid,
      hostProfile: config.profile,
      browserProfile: config.browserProfile,
      network: config.network,
      ...(instance
        ? { cdpEndpoint: instance.cdpEndpoint, agentId: instance.agentId, pageUrl: instance.page.url() }
        : {}),
      // No password, bridge bearer token, hidden cards, raw Observation or private opponent deck.
      controls: {
        host: path.join(REPO_ROOT, 'tools/keyteki-session-host.mjs'),
        keepCurrentGame: true,
        note: 'Operator pause preserves the game. The watchdog recovers or concedes only on verified own-action failure. After a native terminal result is saved, the separate finish handler normally leaves and verifies server seat removal unless leaveAfterFinish is false.',
      },
    });
  };
  const hostRequest = async (route, body) => {
    const response = await fetch(connection.url + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + connection.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || result.runId !== connection.runId) fail('HOST_CONTROL_IDENTITY_CHANGED');
    return result;
  };
  const { hold, clearAutomaticHold } = createHumanHoldController({
    state,
    hostRequest,
    getWatchdog: () => watchdogRuntime,
    save: handoff,
    onHeld: () => {
      console.log(
        JSON.stringify({
          event: 'one-seat-held',
          reason: state.holdReason,
          hostPauseConfirmed: state.hostPauseConfirmed,
          handoff: path.join(config.output, 'handoff.json'),
          browserAndHostPreserved: true,
        }),
      );
    },
  });
  const healthy = () => {
    observer?.assertHealthy();
    if (state.held) fail('DRIVER_ALREADY_HELD');
  };
  const mirror = new wireTools.KeytekiStateStream();
  const signal = () => {
    joinedPendingExit?.close();
    disconnectedExit?.close();
    void hold('OPERATOR_SIGNAL_PAUSED_AND_PRESERVED', { operator: true });
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    const started = await execute(
      process.execPath,
      [
        path.join(REPO_ROOT, 'tools/keyteki-session-host.mjs'),
        'start',
        '--config',
        bridgeConfigPath,
        '--profile',
        config.profile,
      ],
      { cwd: REPO_ROOT, timeout: 25000, maxBuffer: 1024 * 1024 },
    );
    const host = JSON.parse(started.stdout);
    if (host.running !== true || host.reused === true) fail('FRESH_OWN_HOST_NOT_CONFIRMED');
    connection = JSON.parse(fs.readFileSync(path.join(config.profile, 'connection.json'), 'utf8'));
    hostIdentity = { pid: host.pid, runId: connection.runId, configSha256: host.configSha256 };
    const url = new URL(connection.url);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !/^[a-f0-9]{64}$/.test(connection.token) ||
      connection.managedSessions !== true ||
      !sameNames(connection.participants ?? [], config.participants)
    )
      fail('OWN_HOST_BINDING_INVALID');
    // Keep the host actually started by this attempt; later disk contents cannot select a replacement.
    unjoinedHostBinding = {
      expectedHost: { ...hostIdentity, configSha256: host.configSha256 },
      expectedConnection: structuredClone(connection),
    };
    state.phase = 'opening-own-page';
    if (!prepared) {
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
    }
    const page = instance.page;
    await page.setViewportSize({ width: 1440, height: 1100 });
    page.setDefaultTimeout(config.setupTimeoutMs);
    observer ??= new PublicRoomObserver(page, config);
    await observer.ready;
    page.on('pageerror', () => {
      void hold('BROWSER_PAGE_ERROR');
    });
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[KF bridge external-command]'))
        void (async () => {
          const snap = await watchdogRuntime?.snapshot();
          if (!config.watchdog.enabled || snap?.operatorPaused)
            await hold('EXTERNAL_GAME_COMMAND', { operator: true });
        })().catch(() => {});
      if (text.startsWith('[KF bridge paused]') && !text.includes('superseded-owner'))
        void (async () => {
          const snap = await watchdogRuntime?.snapshot();
          if (!config.watchdog.enabled || snap?.strategyPaused) await hold('USERSCRIPT_PAUSED');
        })().catch(() => {});
    });
    watchdogRuntime = await installHumanWatchdog({
      page,
      config,
      observationEnabled,
      connection,
      state,
      observer,
      save: handoff,
      hostRequest,
      clearAutomaticHold,
      restartHost: async ({ signal }) => {
        if (signal.aborted || state.operatorPaused) fail('RECOVERY_CANCELLED');
        const before = { url: connection.url, token: connection.token, runId: connection.runId };
        let result;
        try {
          result = await execute(
            process.execPath,
            [
              path.join(REPO_ROOT, 'tools/keyteki-session-host.mjs'),
              'start',
              '--config',
              bridgeConfigPath,
              '--profile',
              config.profile,
              '--recover-from-run-id',
              before.runId,
            ],
            { cwd: REPO_ROOT, timeout: 25000, maxBuffer: 1024 * 1024, signal },
          );
        } catch (error) {
          if (hostStopWasRequested(config.profile, connection)) {
            state.operatorPaused = true;
            watchdogRuntime.operatorPause();
          }
          throw error;
        }
        const host = JSON.parse(result.stdout),
          next = JSON.parse(fs.readFileSync(path.join(config.profile, 'connection.json'), 'utf8'));
        if (hostStopWasRequested(config.profile, connection) || hostStopWasRequested(config.profile, next)) {
          state.operatorPaused = true;
          watchdogRuntime.operatorPause();
          fail('OPERATOR_STOP_MUST_BE_PRESERVED');
        }
        if (
          !host.running ||
          next.url !== before.url ||
          next.token !== before.token ||
          next.managedSessions !== true ||
          !sameNames(next.participants ?? [], config.participants)
        )
          fail('HOST_CONTROL_IDENTITY_CHANGED');
        // The exposed bridge callback holds this same object. Preserve URL/token and update run identity in place.
        try {
          hostIdentity = bindRecoveredHostConnection(config.profile, connection, hostIdentity, next, host);
        } catch (error) {
          if (error.code === 'OPERATOR_STOP_MUST_BE_PRESERVED') {
            state.operatorPaused = true;
            watchdogRuntime.operatorPause();
          }
          throw error;
        }
        state.hostRestarts = (state.hostRestarts ?? 0) + 1;
        handoff();
      },
      onEvent: (row) =>
        fs.appendFileSync(path.join(config.output, 'watchdog-events.jsonl'), JSON.stringify(row) + '\n', {
          mode: 0o600,
        }),
    });
    await page.exposeBinding(
      '__kfGMRequest',
      createOneSeatBridgeBinding({
        page,
        config,
        connection,
        observer,
        state,
        mirror,
        hold,
        save: handoff,
        watchdog: observationEnabled ? watchdogRuntime : undefined,
        onEvidence,
      }),
    );
    const source = fs.readFileSync(path.join(REPO_ROOT, 'tools/keyteki-shared-strategy.user.js'), 'utf8');
    const bootstrap = managedHumanBootstrap(
      config.origin,
      publicTools.publicTopFrameBootstrap(
        config.origin,
        userscriptBootstrap(
          {
            url: connection.url,
            token: connection.token,
            playerName: config.self.name,
            managedSessions: true,
            socialEnabled: true,
            humanWatchdog: {
              enabled: observationEnabled,
              language: config.social.language,
              allowDisconnectedOpponentExit: config.disconnectedOpponentExit.enabled,
              gameId: config.room.gameId,
              participants: config.participants,
            },
          },
          source,
        ),
      ),
    );
    await page.addInitScript({ content: bootstrap });
    if (prepared) {
      // Lobby uses /socket.io; the observed game starts a new /<game-node>/socket.io.
      // Install in the existing document before the host's normal Start action, without refresh.
      if (!(await page.evaluate(() => window.__kfHumanSocketBootstrapV1?.stage === 'pending')))
        fail('EARLY_SOCKET_CONSTRUCTOR_FORWARDER_MISSING');
      await page.evaluate(bootstrap);
      healthy();
      state.phase = 'waiting-for-human-deck';
      state.createdPreparationWait = { startedAt: Date.now() };
      state.createdPreparationWait.deadlineAt = state.createdPreparationWait.startedAt + config.setupTimeoutMs;
      handoff();
      let start;
      try {
        start = await startOwnBoundRoomUi(page, observer, config);
      } catch (error) {
        if (error?.code !== 'HUMAN_DECK_NOT_READY' || !config.leaveAfterFinish || !observer.createdPending) throw error;
        Object.assign(state.createdPreparationWait, { code: error.code, expiredAt: Date.now() });
        const retired = await retireCreatedPendingRoom({
          page, config, state, tracker: observer.createdPending, hostIdentity,
          inspectHost: () => hostRequest('/status'),
          externalCancellation: () => hostStopWasRequested(config.profile, connection),
          stopHost: () => stopUnjoinedHost(config, unjoinedHostBinding),
          release: () => releaseOwnedHumanBrowser({ pool, instance, config }),
          quiesce: () => { watchdogRuntime?.close(); finishedExit?.close(); disconnectedExit?.close(); },
          afterRetired: () => { observer.dispose(); process.off('SIGINT', signal); process.off('SIGTERM', signal); },
          save: () => { write('created-pending-exit.json', state.createdPendingExit); handoff(); },
        });
        if (!retired) throw error;
        return { config, state, pool, instance, observer, hold, watchdog: watchdogRuntime,
          unjoinedHostBinding, save: handoff };
      }
      write('own-start-receipt.json', start);
      await waitForObserved(
        () => state.fullVerified,
        config.setupTimeoutMs,
        'FIRST_GAME_FULL_NOT_CONFIRMED',
        healthy,
      );
    } else {
      state.phase = 'login-own-account';
      handoff();
      uiSetup = ui.createFuzhouUiSetup({
        origin: config.origin,
        gameType: config.room.gameType,
        timeoutMs: config.setupTimeoutMs,
      });
      preparePlayerInFlight = true;
      await uiSetup.preparePlayer({
        page,
        player: config.self,
        credentials: readOwnCredentials(config),
        origin: config.origin,
      });
      preparePlayerInFlight = false;
      healthy();
      state.phase = 'verify-current-public-listing';
      handoff();
      await waitForObserved(
        () => observer.listing,
        config.setupTimeoutMs,
        'CURRENT_PUBLIC_LISTING_NOT_OBSERVED',
        healthy,
      );
      state.phase = 'join-selected-public-room';
      handoff();
      const pending = await joinObservedPublicRoom(page, observer, config);
      write('own-pending-receipt.json', pending);
      healthy();
      state.phase = 'select-own-deck';
      handoff();
      const selected = await selectOwnDeckUi(page, observer, config, () => state.fullVerified);
      write('own-deck-selection.json', selected);
      if (!state.fullVerified && !state.held) state.phase = 'waiting-for-human-host';
    }
    handoff();
    // The existing room's human host owns Start. This driver never clicks it, controls the
    // other seat, creates another room, or treats waiting as permission to invent a command.
    console.log(
      JSON.stringify({
        event: 'one-seat-prepared',
        gameId: config.room.gameId,
        controlled: config.self.name,
        handoff: path.join(config.output, 'handoff.json'),
        phase: state.phase,
      }),
    );
  } catch (error) {
    if (preparePlayerInFlight) {
      const failure = uiSetup?.getPreparePlayerFailure();
      if (failure) state.setupFailure = failure;
    }
    await hold(error?.code ?? 'ONE_SEAT_SETUP_UNVERIFIED');
  }
  if (watchdogRuntime && instance && connection) {
    finishedExit = installFinishedRoomExit({
      config,
      state,
      save: handoff,
      page: instance.page,
      watchdog: watchdogRuntime,
      inspectChat: () => hostRequest('/status'),
      externalCancellation: () => hostStopWasRequested(config.profile, connection),
      quiesce: async () => {
        const preserveOperator = () => {
          if (
            state.operatorPaused ||
            watchdogRuntime.watchdog.status().phase === 'operator-paused' ||
            hostStopWasRequested(config.profile, connection)
          ) {
            state.operatorPaused = true;
            fail('OPERATOR_PAUSE_MUST_BE_PRESERVED');
          }
        };
        preserveOperator();
        if (!(await watchdogRuntime.quarantine())) fail('FINISHED_STRATEGY_QUIESCENCE_UNCONFIRMED');
        preserveOperator();
        watchdogRuntime.close();
        let chatCancellationConfirmed = false;
        try {
          chatCancellationConfirmed =
            (
              await hostRequest('/operator', {
                action: 'pause',
                intent: 'automatic-finish-quiescence',
              })
            ).paused === true;
        } catch {}
        return { chatCancellationConfirmed };
      },
      onComplete: async () => {
        try {
          if (state.operatorPaused || hostStopWasRequested(config.profile, connection)) {
            state.operatorPaused = true;
            fail('OPERATOR_PAUSE_MUST_BE_PRESERVED');
          }
          await retireFinishedHumanRuntime({
            config, state, connection, hostIdentity,
            operatorPaused: () => watchdogRuntime.watchdog.status().phase === 'operator-paused',
            stopHost: async () => JSON.parse((await execute(process.execPath,
              [path.join(REPO_ROOT, 'tools/keyteki-session-host.mjs'), 'stop', '--profile', config.profile],
              { cwd: REPO_ROOT, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout),
            releaseBrowser: () => releaseOwnedHumanBrowser({ pool, instance, config }),
            afterRetired: () => {
              observer?.dispose();
              disconnectedExit?.close();
              process.off('SIGINT', signal);
              process.off('SIGTERM', signal);
            },
            save: handoff,
          });
        } catch (error) {
          state.finishRetirementError = /^[A-Z0-9_-]+$/.test(error?.code ?? '')
            ? error.code
            : 'FINISHED_RUNTIME_RETIREMENT_UNCONFIRMED';
        }
        handoff();
      },
    });
  }
  if (config.disconnectedOpponentExit.enabled && watchdogRuntime && instance && connection) {
    disconnectedExit = installDisconnectedOpponentExit({
      config, state, page: instance.page, watchdog: watchdogRuntime, connection,
      getHostIdentity: () => hostIdentity,
      inspectHost: () => hostRequest('/status'),
      save: () => {
        if (state.disconnectedOpponentExit) write('disconnected-opponent-exit.json', state.disconnectedOpponentExit);
        handoff();
      },
      stopHost: (departure, expectedHost) => stopDisconnectedHost(config, {
        expectedHost, expectedConnection: { ...connection }, departure,
      }),
      releaseBrowser: () => releaseOwnedHumanBrowser({ pool, instance, config }),
      closePeers: () => {
        watchdogRuntime.close(); finishedExit?.close(); joinedPendingExit?.close();
      },
      afterRetired: () => {
        observer?.dispose();
        process.off('SIGINT', signal); process.off('SIGTERM', signal);
      },
    });
  }
  if (
    !prepared &&
    config.leaveAfterFinish &&
    config.watchdog.enabled &&
    instance &&
    connection &&
    observer?.joinedPending &&
    state.phase === 'waiting-for-human-host' &&
    !state.held
  ) {
    joinedPendingExit = installJoinedPendingRoomExit({
      page: instance.page,
      config,
      state,
      tracker: observer.joinedPending,
      hostIdentity,
      inspectHost: () => hostRequest('/status'),
      externalCancellation: () => hostStopWasRequested(config.profile, connection),
      save: () => {
        write('joined-pending-exit.json', state.joinedPendingExit);
        handoff();
      },
      stopHost: async () =>
        JSON.parse(
          (
            await execute(
              process.execPath,
              [path.join(REPO_ROOT, 'tools/keyteki-session-host.mjs'), 'stop', '--profile', config.profile],
              { cwd: REPO_ROOT, timeout: 20000, maxBuffer: 1024 * 1024 },
            )
          ).stdout,
        ),
      quiesce: () => {
        watchdogRuntime?.close();
        finishedExit?.close();
      },
      release: () => releaseOwnedHumanBrowser({ pool, instance, config }),
      afterRetired: () => {
        observer.dispose();
        disconnectedExit?.close();
        process.off('SIGINT', signal);
        process.off('SIGTERM', signal);
      },
    });
  }
  // Intentionally no finally-close. Keep the Playwright binding alive during handoff so the
  // existing real page and managed host remain inspectable. Native winner is recorded only
  // from our accepted public view; this is never advertised as two-perspective evidence.
  return {
    config,
    state,
    pool,
    instance,
    observer,
    hold,
    watchdog: watchdogRuntime,
    finishedExit,
    joinedPendingExit,
    disconnectedExit,
    unjoinedHostBinding,
    save: handoff,
  };
}

const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
async function cli() {
  const args = process.argv.slice(2),
    i = args.indexOf('--config');
  if (i < 0 || !args[i + 1]) fail('USAGE_CONFIG_REQUIRED');
  const input = JSON.parse(fs.readFileSync(path.resolve(args[i + 1]), 'utf8'));
  const createPublic = args.includes('--create-public');
  if (!args.includes('--run'))
    console.log(JSON.stringify(humanPreflight(input, { createPublic }).report, null, 2));
  else {
    const live = createPublic
      ? await (await import('./keyteki-human-create-public.mjs')).runCreatePublic(input)
      : await runOneSeat(input);
    if (live.state.finishedNoOpponent) return;
    const interval = setInterval(() => live.save(), 15000);
    // Keep bindings alive through play and any unresolved exit; a confirmed normal finish retires this driver.
    while (!live.state.runtimeRetired) await new Promise((resolve) => setTimeout(resolve, 1000));
    clearInterval(interval);
  }
}
if (main)
  void cli().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'human-launcher-failed-before-live-handoff',
        code: error?.code ?? 'CONFIG_OR_DEPENDENCY_ERROR',
      }),
    );
    process.exitCode = 1;
  });
