/** Loopback strategy host. Explicit configured participants; never joins matchmaking itself. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { KeytekiWireSession } from './keyteki-wire-session.mjs';
import { createDecisionEvidenceJournal } from './keyteki-decision-evidence.mjs';
import { KeytekiManagedSessions } from './keyteki-managed-sessions.mjs';
import { acquireBridgeRuntime, readRuntimeJson, writeRuntimeJson } from './keyteki-bridge-runtime.mjs';
import { createBridgeSocial } from './keyteki-bridge-social.mjs';
import { recordHostOperatorIntent } from './keyteki-host-operator-intent.mjs';
import { acceptAutomaticUnjoinedStop } from './keyteki-unjoined-host-stop.mjs';
import { createMinimaxSocialProvider } from './minimax-social-provider.mjs';
import { configuredMinimaxKey } from './minimax-credentials.mjs';
import { normalizeGameSocketPaths } from './site-origin.mjs';
import { validatePublicVeilRuleContract } from '../dist/src/adapters/keyteki-allocation.js';
import { validatePublicCaptureRuleContract } from '../dist/src/adapters/keyteki-public-capture.js';
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i < 0 ? fallback : args[i + 1];
}
const configPath = arg('config');
if (!configPath) throw Error('Supply --config with origin, participants and per-player strategies');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const gameSocketPaths = normalizeGameSocketPaths(config.gameSocketPaths);
const configSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const runtime = arg('profile') ? acquireBridgeRuntime(arg('profile')) : null;
const managed = config.managedSessions === true || runtime !== null;
const connection = path.resolve(
  arg('connection', runtime?.connectionFile ?? '.state/kf-browser-bridge-connection.json'),
);
const checkpointFile = runtime?.checkpointFile ?? config.checkpointFile;
const previous = runtime ? readRuntimeJson(connection, null) : null;
const checkpoint = managed && checkpointFile ? readRuntimeJson(checkpointFile, null) : null;
if (checkpoint && checkpoint.schema !== 'kf-bridge-checkpoint-v1')
  throw Error('Unsupported bridge checkpoint');
const origins = new Set(config.origins ?? []);
if (!origins.size || [...origins].some((x) => new URL(x).origin !== x))
  throw Error('Explicit origin list required');
if (config.publicVeilRuleContract) {
  if (config.verifiedVeilScope) throw Error('Local and public Veil capabilities cannot share a bridge');
  if (origins.size !== 1 || !origins.has(config.publicVeilRuleContract.origin))
    throw Error('Public Veil contract requires one exact configured origin');
  validatePublicVeilRuleContract(config.publicVeilRuleContract, {
    origin: [...origins][0],
    frontendBundleSha256: config.frontendBundleSha256,
    participants: config.participants,
    deckLists: config.deckLists,
  });
}
if (config.publicCaptureRuleContract) {
  if (config.verifiedVeilScope) throw Error('Local and public capture capabilities cannot share a bridge');
  if (origins.size !== 1 || !origins.has(config.publicCaptureRuleContract.origin))
    throw Error('Public capture contract requires one exact configured origin');
  validatePublicCaptureRuleContract(config.publicCaptureRuleContract, {
    origin: [...origins][0],
    frontendBundleSha256: config.frontendBundleSha256,
    participants: config.participants,
    deckLists: config.deckLists,
  });
}
const fixtureScopeFor = (origin) => {
  const url = new URL(origin);
  // A verified local installation is not evidence of a public server deployment.
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    ? config.verifiedVeilScope
    : undefined;
};
const token =
    previous && /^[a-f0-9]{64}$/.test(previous.token) ? previous.token : randomBytes(32).toString('hex'),
  sessions = new Map();
let providerModule;
if (config.providerModule)
  providerModule = await import(pathToFileURL(path.resolve(config.providerModule)).href);
const strategyByName = new Map();
for (const p of config.players ?? []) {
  if (!config.participants?.includes(p.name))
    throw Error('Player is not a configured private-test participant');
  strategyByName.set(p.name, {
    codePolicy: p.codePolicy ?? 'tempo-v3',
    mode: p.mode ?? 'code',
    ...(p.mode && p.mode !== 'code'
      ? { model: await providerModule.createProvider({ playerName: p.name, mode: p.mode }) }
      : {}),
  });
}
// This path is the attempt's formal private output, never the temporary browser profile.
const decisionEvidence =
  config.decisionEvidence === true
    ? createDecisionEvidenceJournal({
        output: config.decisionEvidenceOutput,
        hostRunId: runtime?.runId ?? randomBytes(16).toString('hex'),
      })
    : null;
const createSession = ({ origin, playerName }) =>
  new KeytekiWireSession({
    playerName,
    participants: config.participants,
    strategy: strategyByName.get(playerName),
    ...(decisionEvidence ? { onDecisionEvidence: (row) => decisionEvidence.record(row) } : {}),
    deckLists: config.deckLists,
    verifiedVeilScope: fixtureScopeFor(origin),
    publicVeilRuleContract:
      config.publicVeilRuleContract?.origin === origin ? config.publicVeilRuleContract : undefined,
    publicCaptureRuleContract:
      config.publicCaptureRuleContract?.origin === origin ? config.publicCaptureRuleContract : undefined,
    origin,
    gameSocketPaths,
    frontendBundleSha256: config.frontendBundleSha256,
  });
const manager = managed
  ? new KeytekiManagedSessions({ createSession, checkpoint: checkpoint?.manager, gameSocketPaths })
  : null;
let socialProvider,
  social,
  operatorPaused = false,
  stopping = false;
let automaticRetirement = null;
if (config.social?.enabled === true) {
  if (!managed) throw Error('Social chat requires managed sessions');
  if (config.social.providerModule) {
    const module = await import(pathToFileURL(path.resolve(config.social.providerModule)).href);
    socialProvider = await module.createSocialProvider();
  } else {
    socialProvider = createMinimaxSocialProvider({
      apiKey: configuredMinimaxKey(),
      model: config.social.model,
      timeoutMs: config.social.timeoutMs,
      maxOutputTokens: config.social.maxOutputTokens,
      onReceipt: (receipt) => console.log(JSON.stringify({ event: 'social-provider', receipt })),
    });
  }
  if (typeof socialProvider?.generate !== 'function') throw Error('Social text provider required');
  social = createBridgeSocial({
    manager,
    generate: socialProvider.generate,
    strategies: strategyByName,
    knownBotNames: [...new Set([...strategyByName.keys(), ...(config.social.knownBotNames ?? [])])],
    policy: config.social.policy,
    checkpoints: checkpoint?.social,
    onEvent: (event) => console.log(JSON.stringify({ event: 'social-event', data: event })),
  });
}
let lastCheckpoint = null;
function persist() {
  if (!manager || !checkpointFile) return;
  const value = {
    schema: 'kf-bridge-checkpoint-v1',
    manager: manager.exportCheckpoint(),
    social: social?.exportCheckpoint() ?? [],
  };
  const signature = JSON.stringify(value);
  if (signature === lastCheckpoint) return;
  writeRuntimeJson(path.resolve(checkpointFile), { ...value, updatedAt: new Date().toISOString() });
  lastCheckpoint = signature;
}
function observeSocial(data) {
  if (!social || operatorPaused || stopping) return;
  try {
    social.observe(data);
  } catch {
    social.suspend(data);
    console.log(
      JSON.stringify({
        event: 'social-observation-skipped',
        gameId: data.gameId,
        playerName: data.playerName,
      }),
    );
  }
}
function status() {
  return {
    protocol: 'kf-loopback-bridge-v1',
    managedSessions: managed,
    runId: runtime?.runId ?? null,
    configSha256,
    pid: process.pid,
    paused: operatorPaused,
    stopping,
    ...(automaticRetirement ? { automaticRetirement } : {}),
    sessions: manager?.summary().sessions ?? [...sessions.values()].map((session) => session.describe()),
    restoredSessions: manager?.summary().restoredSessions ?? [],
    social: social?.summary() ?? [],
  };
}
function auth(req) {
  const actual = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(token));
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0,
    chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw Error('Oversize state');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health')
    return reply(res, 200, {
      protocol: 'kf-loopback-bridge-v1',
      managedSessions: managed,
      sessions: manager
        ? manager.summary().sessions.length + manager.summary().restoredSessions.length
        : sessions.size,
    });
  if (!auth(req)) return reply(res, 401, { error: 'Authentication required' });
  try {
    if (req.method === 'GET' && req.url === '/status') return reply(res, 200, status());
    const data = await body(req);
    if (req.url === '/operator' && req.method === 'POST') {
      const automaticStop = data.action === 'stop' && data.intent === 'automatic-unjoined-retirement';
      const finishQuiescence = data.action === 'pause' && data.intent === 'automatic-finish-quiescence';
      if (automaticStop) {
        automaticRetirement = acceptAutomaticUnjoinedStop({
          profile: runtime?.root,
          runId: runtime?.runId,
          configSha256,
          status: status(),
          request: data,
        });
      } else if (finishQuiescence) {
        const current = status();
        if (!current.sessions.length || current.sessions.some((session) => session.status !== 'finished'))
          throw Error('Automatic finish pause requires terminal sessions');
      } else if (runtime && ['pause', 'resume', 'stop'].includes(data.action)) {
        recordHostOperatorIntent(runtime.root, { runId: runtime.runId }, data.action);
      }
      if (data.action === 'pause') operatorPaused = true;
      else if (data.action === 'resume') operatorPaused = false;
      else if (data.action === 'stop') {
        reply(res, 200, {
          stopping: true,
          runId: runtime?.runId ?? null,
          pid: process.pid,
          ...(automaticRetirement ? { automaticRetirement } : {}),
        });
        void stop({ automatic: automaticStop });
        return;
      } else throw Error('Unknown operator action');
      if (operatorPaused) social?.close();
      persist();
      return reply(res, 200, status());
    }
    if (!origins.has(data.origin) || !strategyByName.has(data.playerName))
      return reply(res, 403, { error: 'Unconfigured origin or player' });
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(data.sessionId ?? '')) throw Error('Invalid browser session id');
    if (managed) {
      let state;
      if (req.method !== 'POST') return reply(res, 405, { error: 'POST required' });
      if (req.url === '/attach' || req.url === '/transport-resume') {
        state = manager.attach({ ...data, browserSequence: data.sequence });
        observeSocial({ ...data, ownerEpoch: state.ownerEpoch });
      } else if (req.url === '/state') {
        state = manager.receive(data);
        observeSocial(data);
      } else if (req.url === '/decision') {
        state =
          operatorPaused || stopping
            ? { ...manager.describe(data), decision: null, operatorPaused: true }
            : manager.offer(data);
      } else if (req.url === '/send-intent') {
        if (operatorPaused || stopping) throw Error('Host paused');
        state = manager.authorize(data);
      } else if (req.url === '/sent') state = manager.confirmSent(data);
      else if (req.url === '/reject') state = manager.reject(data);
      else if (req.url === '/detach' || req.url === '/transport-close') {
        state = manager.detach(data);
        social?.suspend(data);
      } else if (req.url === '/unknown' || req.url === '/disconnect') {
        state = manager.unknown(data);
        social?.suspend(data);
      } else if (req.url === '/activity') {
        state = manager.externalActivity(data);
        social?.suspend(data);
      } else if (req.url === '/clear') {
        state = manager.clear(data);
        social?.suspend(data);
      } else if (req.url === '/status') state = manager.describe(data);
      else if (req.url === '/social/next') {
        manager.describe(data);
        state = { packet: operatorPaused || stopping ? null : (social?.next(data) ?? null) };
      } else if (req.url === '/social/send-intent') {
        if (!social || operatorPaused || stopping) throw Error('Social chat unavailable');
        state = social.authorize(data);
      } else if (req.url === '/social/sent') {
        manager.describe(data);
        state = { settled: social?.settle(data) ?? false };
      } else return reply(res, 404, { error: 'Unknown managed route' });
      // Commit small recovery metadata before granting send authority. Full player
      // states, strategy objects, and acknowledged model dialogue remain in Node.
      if (req.url !== '/decision' && req.url !== '/status') persist();
      return reply(res, 200, state);
    }
    const key = JSON.stringify([data.origin, data.playerName, data.sessionId]);
    if (req.url === '/state' && req.method === 'POST') {
      let session = sessions.get(key);
      if (!session) {
        session = new KeytekiWireSession({
          playerName: data.playerName,
          participants: config.participants,
          strategy: strategyByName.get(data.playerName),
          ...(decisionEvidence ? { onDecisionEvidence: (row) => decisionEvidence.record(row) } : {}),
          deckLists: config.deckLists,
          verifiedVeilScope: fixtureScopeFor(data.origin),
          publicVeilRuleContract:
            config.publicVeilRuleContract?.origin === data.origin ? config.publicVeilRuleContract : undefined,
          publicCaptureRuleContract:
            config.publicCaptureRuleContract?.origin === data.origin
              ? config.publicCaptureRuleContract
              : undefined,
          origin: data.origin,
          frontendBundleSha256: config.frontendBundleSha256,
        });
        sessions.set(key, session);
      }
      return reply(res, 200, session.receive(data.delta, data.sequence, data.transport));
    }
    const session = sessions.get(key);
    if (!session) return reply(res, 409, { error: 'Initial full state required' });
    if (req.url === '/transport-close' && req.method === 'POST')
      return reply(res, 200, session.suspendTransport(data));
    if (req.url === '/transport-resume' && req.method === 'POST')
      return reply(res, 200, session.resumeTransport(data));
    if (req.url === '/decision' && req.method === 'POST')
      return reply(res, 200, { ...session.describe(), decision: session.take() });
    if (req.url === '/sent' && req.method === 'POST') {
      session.confirmSent(data.decisionId, data.sequence, {
        queuedCount: data.queuedCount,
        planId: data.planId,
      });
      return reply(res, 200, session.describe());
    }
    if (req.url === '/unknown' && req.method === 'POST') {
      session.unknown(data.decisionId, data.reason ?? 'client-send-outcome-unknown', data.queuedCount ?? 0);
      return reply(res, 200, session.describe());
    }
    if (req.url === '/activity' && req.method === 'POST') {
      session.externalActivity(data.epoch, data.reason ?? 'external-game-command');
      return reply(res, 200, session.describe());
    }
    if (req.url === '/disconnect' && req.method === 'POST') {
      session.disconnect(data.reason ?? 'game-transport-closed');
      return reply(res, 200, session.describe());
    }
    if (req.url === '/reject' && req.method === 'POST') {
      session.reject(data.decisionId, data.reason ?? 'client-not-sent');
      return reply(res, 200, session.describe());
    }
    if (req.url === '/clear' && req.method === 'POST') {
      session.disconnect('game-cleared');
      const lastState = session.describe();
      sessions.delete(key);
      return reply(res, 200, { cleared: true, lastState });
    }
    return reply(res, 404, { error: 'Unknown route' });
  } catch (error) {
    reply(res, 409, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(managed ? { managed: true } : {}),
    });
  }
});
const previousPort =
  previous?.url && new URL(previous.url).hostname === '127.0.0.1' ? new URL(previous.url).port : '0';
const port = Number(arg('port', runtime ? (previousPort ?? '0') : '0'));
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
fs.mkdirSync(path.dirname(connection), { recursive: true });
fs.writeFileSync(
  connection,
  JSON.stringify(
    {
      url: 'http://127.0.0.1:' + server.address().port,
      token,
      participants: config.participants,
      origins: [...origins],
      managedSessions: managed,
      socialEnabled: Boolean(social),
      ...(runtime ? { runId: runtime.runId } : {}),
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    ready: true,
    url: 'http://127.0.0.1:' + server.address().port,
    connectionFile: connection,
    participants: config.participants,
  }),
);
async function stop({ automatic = false } = {}) {
  if (stopping) return;
  stopping = true;
  if (!automatic) operatorPaused = true;
  if (runtime) setTimeout(() => process.exit(0), 2000).unref();
  social?.close();
  try {
    persist();
  } finally {
    decisionEvidence?.finish();
    server.close();
  }
  await providerModule?.closeProvider?.();
  await socialProvider?.close?.();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('exit', () => decisionEvidence?.finish());
