/** Finish retirement preserves late operator pauses after the watchdog has closed. */
import { finishedRoomMatches } from './keyteki-finished-room-exit.mjs';
import { ownedHostOperatorAction } from './keyteki-host-operator-intent.mjs';
const fail = (code) => { throw Object.assign(Error(code), { code }); };

export async function retireFinishedHumanRuntime({
  config, state, connection, hostIdentity, stopHost, releaseBrowser,
  operatorPaused = () => false, afterRetired = () => {}, save = () => {},
  readAction = ownedHostOperatorAction,
}) {
  const exit = state.roomExit, server = exit?.server;
  if (state.fullVerified !== true || !finishedRoomMatches(state, config) ||
      exit?.phase !== 'left-confirmed' || exit.gameId !== config.room.gameId ||
      exit.playerName !== config.self.name || exit.serverSeatAbsent !== true ||
      server?.gameId !== config.room.gameId || server.playerName !== config.self.name ||
      server.serverSeatAbsent !== true || server.seatPresent !== false ||
      server.ownSeatPreviouslyObserved !== true || !Number.isSafeInteger(server.ordinal) || server.ordinal < 1 ||
      !['games', 'newgame', 'updategame', 'removegame'].includes(server.source) ||
      hostIdentity?.runId !== connection?.runId || !Number.isSafeInteger(hostIdentity?.pid))
    fail('FINISHED_RETIREMENT_IDENTITY_UNCONFIRMED');
  const assertOperator = (allowCommittedStop) => {
    const action = readAction(config.profile, connection);
    if (state.operatorPaused || operatorPaused() || action === 'pause' ||
        (action === 'stop' && !allowCommittedStop)) {
      state.operatorPaused = true;
      fail('OPERATOR_PAUSE_MUST_BE_PRESERVED');
    }
    if (!['start', 'stop', 'resume'].includes(action)) fail('HOST_OPERATOR_INTENT_UNCONFIRMED');
  };
  assertOperator(false);
  state.retirementCommit = {
    gameId: config.room.gameId, playerName: config.self.name, winner: state.finalPublicView.winner,
    absenceOrdinal: server.ordinal, hostRunId: connection.runId,
  };
  const stopped = await stopHost();
  if (stopped?.stopped !== true || stopped.runId !== connection.runId || stopped.pid !== hostIdentity.pid)
    fail('FINISHED_HOST_STOP_UNCONFIRMED');
  state.hostStoppedAfterFinish = true;
  save();
  // The stop CLI records its own action. Only that action is allowed after this exact departure commit;
  // a later explicit pause still wins, even though the watchdog no longer refreshes in-memory state.
  assertOperator(true);
  await releaseBrowser();
  state.browserLeaseReleasedAfterFinish = true;
  save();
  assertOperator(true);
  afterRetired();
  state.runtimeRetired = true;
  state.phase = 'finished-left';
}
