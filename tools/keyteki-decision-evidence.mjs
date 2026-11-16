/** Private, bounded dispatch evidence. No scoring, policy calls or gameplay failure path. */
import fs from 'node:fs';
import path from 'node:path';
import { strategyFrameHash } from '../dist/src/ai/strategy-controller.js';

export const DECISION_EVIDENCE_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxRecords: 4096,
  maxRecordBytes: 1024 * 1024,
});
const schema = 'kf-decision-evidence-v1';
const key = (row) => JSON.stringify([row.hostRunId, row.gameId, row.playerName, row.decision.id]);

const MAX_UNDEFINED_PATHS = 8192,
  MAX_FRAME_DEPTH = 64;
function encodeFrame(frame) {
  const undefinedPaths = [];
  const visit = (value, parts) => {
    if (parts.length > MAX_FRAME_DEPTH) throw Error('Evidence frame depth limit');
    if (value === undefined) {
      if (undefinedPaths.length >= MAX_UNDEFINED_PATHS) throw Error('Evidence undefined path limit');
      undefinedPaths.push(parts);
    } else if (value && typeof value === 'object') {
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw Error('Evidence frame is not plain data');
      if (
        Array.isArray(value) &&
        Array.from({ length: value.length }, (_, i) => i).some((i) => !Object.hasOwn(value, i))
      )
        throw Error('Evidence frame has a sparse array');
      for (const [name, child] of Object.entries(value))
        visit(child, [...parts, Array.isArray(value) ? Number(name) : name]);
    } else if (
      (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw Error('Evidence frame is not JSON data');
  };
  visit(frame, []);
  return {
    frameEncoding: 'json-with-undefined-paths-v1',
    frame: JSON.parse(JSON.stringify(frame)),
    undefinedPaths,
  };
}

/** Recover the exact controller input, including canonical's explicit undefined properties. */
export function restoreDecisionEvidenceFrame(row) {
  if (
    row.frameEncoding !== 'json-with-undefined-paths-v1' ||
    !Array.isArray(row.undefinedPaths) ||
    row.undefinedPaths.length > MAX_UNDEFINED_PATHS
  )
    throw Error('Invalid evidence frame encoding');
  const frame = structuredClone(row.frame),
    seen = new Set();
  for (const parts of row.undefinedPaths) {
    if (!Array.isArray(parts) || !parts.length || parts.length > MAX_FRAME_DEPTH)
      throw Error('Invalid undefined path');
    const id = JSON.stringify(parts);
    if (seen.has(id)) throw Error('Duplicate undefined path');
    seen.add(id);
    let parent = frame;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i],
        last = i === parts.length - 1;
      if (
        !parent ||
        typeof parent !== 'object' ||
        (Array.isArray(parent)
          ? !Number.isSafeInteger(name) || name < 0 || name >= parent.length
          : typeof name !== 'string')
      )
        throw Error('Invalid undefined path container');
      if (!last) {
        if (!Object.hasOwn(parent, name)) throw Error('Missing undefined path container');
        parent = parent[name];
      } else {
        if (Array.isArray(parent) ? parent[name] !== null : Object.hasOwn(parent, name))
          throw Error('Invalid undefined path leaf');
        Object.defineProperty(parent, name, {
          value: undefined,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  if (strategyFrameHash(frame) !== row.decision.observationSha256)
    throw Error('Evidence frame hash mismatch');
  return frame;
}

/** Synchronous bounded appends have no pending queue. Only finish() fsyncs the journal. */
export function createDecisionEvidenceJournal({
  output,
  hostRunId,
  limits = {},
  io = fs,
  warn = console.error,
}) {
  const cap = { ...DECISION_EVIDENCE_LIMITS, ...limits };
  for (const [name, value] of Object.entries(cap))
    if (!Number.isSafeInteger(value) || value < 1 || value > DECISION_EVIDENCE_LIMITS[name])
      throw Error('INVALID_DECISION_EVIDENCE_LIMIT');
  const journal = path.join(output, 'decision-evidence.jsonl'),
    receipt = path.join(output, 'decision-evidence-status.json'),
    temporary = receipt + '.' + process.pid + '.tmp';
  let fd,
    warned = false;
  const seen = new Set();
  const state = {
    schema: 'kf-decision-evidence-status-v1',
    hostRunId,
    coverage: 'ordinary-gameplay-dispatch-and-allocation-final-only',
    dispatchedIsNotQueuedOrAcknowledged: true,
    scoresCaptured: false,
    limits: cap,
    bytes: 0,
    records: 0,
    attempted: 0,
    duplicatesSkipped: 0,
    droppedRecords: 0,
    ioFailures: 0,
    validationFailures: 0,
    uncleanRestarts: 0,
    partialTailPossible: false,
    disabled: false,
    closed: false,
    flushed: false,
    lastGap: null,
  };
  const snapshot = () => structuredClone(state);
  const failure = (code) => {
    state.ioFailures++;
    state.disabled = true;
    state.lastGap = code;
    if (!warned) {
      warned = true;
      try {
        warn(JSON.stringify({ event: 'decision-evidence-failure', code, hostRunId }));
      } catch {}
    }
  };
  const save = () => {
    let receiptFd,
      created = false;
    try {
      receiptFd = io.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      io.writeFileSync(receiptFd, JSON.stringify(state) + '\n');
      io.closeSync(receiptFd);
      receiptFd = undefined;
      io.renameSync(temporary, receipt);
    } catch {
      failure('RECEIPT_WRITE_FAILED');
      try {
        if (receiptFd !== undefined) io.closeSync(receiptFd);
      } catch {}
      try {
        if (created) io.rmSync(temporary, { force: true });
      } catch {}
    }
  };
  try {
    io.mkdirSync(output, { recursive: true, mode: 0o700 });
    let prior;
    try {
      prior = JSON.parse(io.readFileSync(receipt, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (prior) {
      if (prior.schema !== state.schema) throw Error('Prior evidence receipt schema');
      for (const name of [
        'attempted',
        'duplicatesSkipped',
        'droppedRecords',
        'ioFailures',
        'validationFailures',
        'uncleanRestarts',
      ])
        if (Number.isSafeInteger(prior[name]) && prior[name] >= 0) state[name] = prior[name];
      state.uncleanRestarts += prior.closed === true ? 0 : 1;
      state.partialTailPossible = prior.partialTailPossible === true;
      state.lastGap = prior.lastGap ?? null;
    }
    fd = io.openSync(
      journal,
      fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const stat = io.fstatSync(fd);
    state.bytes = stat.size;
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > cap.maxBytes)
      throw Error('Existing evidence is not a bounded private file');
    const text = io.readFileSync(fd, 'utf8');
    if (text && !text.endsWith('\n')) {
      state.partialTailPossible = true;
      throw Error('Incomplete previous evidence record');
    }
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.schema !== schema || !row.decision?.id) throw Error('Previous evidence schema');
      seen.add(key(row));
      state.records++;
    }
    if (state.records > cap.maxRecords) throw Error('Existing record limit exceeded');
    if (state.bytes && !prior) state.uncleanRestarts++;
  } catch {
    failure('JOURNAL_OPEN_OR_RECOVERY_FAILED');
  }
  save();
  return {
    record(input) {
      if (state.closed) return false;
      state.attempted++;
      let writing = false;
      try {
        if (state.disabled) {
          state.droppedRecords++;
          save();
          return false;
        }
        const { frame, decision: d, playerName, nodeSequence, allocation } = input,
          o = frame.observation,
          foe = o.players[o.you === 0 ? 1 : 0],
          chosen = o.legalActions.find((action) => action.id === d.actionId);
        if (
          foe.hand !== undefined ||
          foe.archives !== undefined ||
          !chosen ||
          frame.matchId !== d.matchId ||
          o.revision !== d.revision ||
          o.you !== d.actor ||
          strategyFrameHash(frame) !== d.observationSha256
        )
          throw Error('Invalid observation-only dispatch binding');
        const row = {
          schema,
          hostRunId,
          gameId: frame.matchId,
          playerName,
          nodeSequence,
          stage: 'dispatched',
          decision: Object.fromEntries(
            [
              'id',
              'matchId',
              'actor',
              'revision',
              'actionId',
              'observationSha256',
              'strategy',
              'controller',
              'elapsedMs',
            ].map((name) => [name, d[name]]),
          ),
          chosenAction: chosen.action,
          ...encodeFrame(frame),
          scores: null,
          scoreStatus: 'not-captured',
          ...(allocation
            ? {
                allocation: {
                  id: allocation.id,
                  coverage: 'batch-final-only',
                  decisionIds: allocation.decisionIds,
                  targets: allocation.targets,
                },
              }
            : {}),
        };
        const identity = key(row);
        if (seen.has(identity)) {
          state.duplicatesSkipped++;
          save();
          return false;
        }
        const line = JSON.stringify(row) + '\n',
          bytes = Buffer.byteLength(line);
        if (
          bytes > cap.maxRecordBytes ||
          state.bytes + bytes > cap.maxBytes ||
          state.records >= cap.maxRecords
        ) {
          state.droppedRecords++;
          state.lastGap = bytes > cap.maxRecordBytes ? 'RECORD_SIZE_LIMIT' : 'JOURNAL_CAPACITY_LIMIT';
          if (state.lastGap === 'JOURNAL_CAPACITY_LIMIT') state.disabled = true;
          save();
          return false;
        }
        writing = true;
        io.appendFileSync(fd, line, 'utf8');
        state.bytes += bytes;
        state.records++;
        seen.add(identity);
        save();
        return true;
      } catch {
        state.droppedRecords++;
        state.partialTailPossible ||= writing;
        try {
          if (fd !== undefined) state.bytes = io.fstatSync(fd).size;
        } catch {}
        if (writing) failure('RECORD_WRITE_FAILED');
        else {
          state.validationFailures++;
          state.disabled = true;
          state.lastGap = 'RECORD_VALIDATION_FAILED';
        }
        save();
        return false;
      }
    },
    snapshot,
    finish() {
      if (state.closed) return snapshot();
      if (fd !== undefined) {
        try {
          io.fsyncSync(fd);
          state.flushed = true;
        } catch {
          failure('JOURNAL_FLUSH_FAILED');
        }
        try {
          io.closeSync(fd);
        } catch {
          failure('JOURNAL_CLOSE_FAILED');
        }
        fd = undefined;
      }
      state.closed = true;
      save();
      return snapshot();
    },
  };
}
