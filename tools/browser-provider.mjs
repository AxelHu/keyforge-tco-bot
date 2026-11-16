/** Linux browser leases for this package. No global agent configuration or implicit shared profile. */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserProfileRoot, browserRegistryRoot, browserRecordPath } from './browser-paths.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
function atomic(file, value) {
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('BROWSER_LEASE_UNREADABLE');
  }
}

/** Missing or unreadable identity are different outcomes. Flattened Chrome argv is irrelevant here. */
export function inspectBrowserProcess(pid, { readFile = fs.readFileSync, readLink = fs.readlinkSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  let stat;
  try {
    stat = readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return { state: ['ENOENT', 'ESRCH'].includes(error.code) ? 'absent' : 'unknown' };
  }
  const end = stat.lastIndexOf(')');
  if (end < 1) return { state: 'unknown' };
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] ?? '')) return { state: 'unknown' };
  let executable = null;
  try {
    executable = readLink(`/proc/${pid}/exe`);
  } catch {}
  return { state: fields[0] === 'Z' ? 'exited' : 'present', startId: fields[19], executable };
}
export function browserProcessDisposition(binding, observed) {
  if (!Number.isSafeInteger(binding?.pid) || binding.pid <= 0 || !/^[0-9]+$/.test(binding.startId ?? ''))
    return 'unknown';
  if (observed?.state === 'absent' || observed?.state === 'exited') return 'gone';
  if (observed?.state !== 'present' || !/^[0-9]+$/.test(observed.startId ?? '')) return 'unknown';
  if (observed.startId !== binding.startId) return 'gone';
  if (binding.executable && observed.executable !== binding.executable) return 'unknown';
  return 'same';
}
const disposition = (binding) => browserProcessDisposition(binding, inspectBrowserProcess(binding?.pid));
export function validateBrowserLease(record, { profileDir, endpoint, clientId, agentId, clientPid } = {}) {
  if (
    !object(record) ||
    record.version !== 2 ||
    record.managed !== true ||
    record.profileDir !== profileDir ||
    !object(record.clients)
  )
    fail('BROWSER_LEASE_IDENTITY_CHANGED');
  if (!Number.isSafeInteger(record.process?.pid) || !/^[0-9]+$/.test(record.process?.startId ?? ''))
    fail('BROWSER_LEASE_PROCESS_UNBOUND');
  if (endpoint !== undefined && record.endpoint !== endpoint) fail('BROWSER_LEASE_ENDPOINT_CHANGED');
  if (
    clientId !== undefined &&
    (record.clients[clientId]?.agentId !== agentId || record.clients[clientId]?.pid !== clientPid)
  )
    fail('BROWSER_LEASE_CLIENT_CHANGED');
  return record;
}
export function retainBrowserClients(clients, inspect = inspectBrowserProcess) {
  // An unobservable client is retained; it is never silently declared dead.
  return Object.fromEntries(
    Object.entries(clients).filter(
      ([, client]) => browserProcessDisposition(client, inspect(client?.pid)) !== 'gone',
    ),
  );
}
async function withLock(file, operation) {
  const program =
    'import fcntl,os,sys\nf=os.fdopen(os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600),"r+")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)\nprint("locked",flush=True)\nsys.stdin.read()\n';
  const child = spawn('python3', ['-c', program, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let code;
  const exited = new Promise((resolve) =>
    child.once('exit', (value) => {
      code = value;
      resolve();
    }),
  );
  child.stdin.on('error', () => {});
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      let text = '',
        settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(Error('BROWSER_LEASE_LOCK_TIMEOUT')), 5000);
      child.once('error', () => finish(Error('PYTHON_FCNTL_REQUIRED')));
      child.once('exit', () => finish(Error('BROWSER_LEASE_LOCK_BUSY')));
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.includes('locked\n')) finish();
      });
    });
    return await operation();
  } finally {
    child.stdin.end();
    await Promise.race([exited, sleep(1000)]);
    // Closing stdin releases this exact lock holder; no unbound PID signal is used.
  }
}
function endpointParts(endpoint) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)
  )
    fail('BROWSER_ENDPOINT_INVALID');
  return url;
}
function devtoolsFile(profileDir) {
  try {
    const [port, pathname] = fs
      .readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8')
      .trim()
      .split(/\r?\n/);
    if (!/^\d+$/.test(port)) return null;
    const endpoint = `ws://127.0.0.1:${port}${pathname}`;
    endpointParts(endpoint);
    return endpoint;
  } catch {
    return null;
  }
}
async function endpointAlive(endpoint) {
  try {
    const expected = endpointParts(endpoint);
    const response = await fetch(`http://127.0.0.1:${expected.port}/json/version`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    const actual = endpointParts((await response.json()).webSocketDebuggerUrl);
    return response.ok && actual.href === expected.href;
  } catch {
    return false;
  }
}
export function browserExecutable(options = {}, env = process.env) {
  const candidate = options.chromePath || env.KF_BOT_CHROME || chromium.executablePath();
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    fail('CHROMIUM_NOT_INSTALLED');
  const resolved = fs.realpathSync(candidate);
  const fd = fs.openSync(resolved, 'r');
  try {
    const signature = Buffer.alloc(4);
    fs.readSync(fd, signature, 0, 4, 0);
    if (!signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('DIRECT_CHROMIUM_BINARY_REQUIRED');
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}
/** Bind a kernel process handle before checking /proc, then signal that handle only. */
export function signalOwnedBrowser(binding, signal, { execute = execFileSync } = {}) {
  if (
    !Number.isSafeInteger(binding?.pid) ||
    binding.pid <= 0 ||
    !/^[0-9]+$/.test(binding.startId ?? '') ||
    typeof binding.executable !== 'string' ||
    !path.isAbsolute(binding.executable) ||
    !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)
  )
    fail('BROWSER_SIGNAL_BINDING_INVALID');
  const program = `import os,sys,signal,json
pid=int(sys.argv[1]); expected_start=sys.argv[2]; expected_exe=sys.argv[3]; requested=sys.argv[4]
fd=None
try:
 fd=os.pidfd_open(pid,0)
 text=open('/proc/'+str(pid)+'/stat').read()
 fields=text[text.rfind(')')+2:].split()
 if fields[19]!=expected_start or os.readlink('/proc/'+str(pid)+'/exe')!=expected_exe:
  print(json.dumps({'state':'binding-changed'})); sys.exit(0)
 signal.pidfd_send_signal(fd,getattr(signal,requested),None,0)
 print(json.dumps({'state':'sent'}))
except ProcessLookupError:
 print(json.dumps({'state':'gone'}))
except FileNotFoundError:
 print(json.dumps({'state':'gone'}))
except Exception:
 print(json.dumps({'state':'unobserved'}))
finally:
 if fd is not None: os.close(fd)
`;
  let result;
  try {
    result = JSON.parse(
      execute('python3', ['-c', program, String(binding.pid), binding.startId, binding.executable, signal], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4096,
      }),
    );
  } catch {
    fail('BROWSER_PIDFD_SIGNAL_UNAVAILABLE');
  }
  if (!['sent', 'gone'].includes(result?.state)) fail('BROWSER_PIDFD_IDENTITY_UNCONFIRMED');
  return result.state;
}
async function stopOwnedProcess(binding, endpoint) {
  const state = disposition(binding);
  if (state === 'gone') return true;
  if (state !== 'same') fail('BROWSER_PROCESS_IDENTITY_UNOBSERVED');
  if (endpoint && (await endpointAlive(endpoint))) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
      if (disposition(binding) !== 'same') fail('BROWSER_PROCESS_IDENTITY_CHANGED');
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
    } catch (error) {
      if (error.code) throw error;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    const deadline = Date.now() + 1500;
    while (disposition(binding) === 'same' && Date.now() < deadline) await sleep(40);
  }
  for (const [signal, grace] of [
    ['SIGTERM', 1500],
    ['SIGKILL', 2000],
  ]) {
    const current = disposition(binding);
    if (current === 'gone') return true;
    if (current !== 'same') fail('BROWSER_PROCESS_IDENTITY_UNOBSERVED');
    signalOwnedBrowser(binding, signal);
    const deadline = Date.now() + grace;
    while (disposition(binding) === 'same' && Date.now() < deadline) await sleep(40);
  }
  return disposition(binding) === 'gone';
}

export class AgentBrowser {
  constructor(options = {}) {
    if (process.platform !== 'linux') fail('LINUX_BROWSER_LEASES_REQUIRED');
    if (options.mode && options.mode !== 'per-agent') fail('EXPLICIT_PER_AGENT_BROWSER_REQUIRED');
    this.options = options;
    this.root = browserProfileRoot();
    this.registry = browserRegistryRoot();
    this.liveInstances = new Map();
    this.pending = new Map();
    this.selections = new Map();
    this.closePromises = new Map();
    this.closingAll = null;
    if (options.cleanupOnExit) {
      this.signal = () => {
        void this.closeAll().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once('SIGINT', this.signal);
      process.once('SIGTERM', this.signal);
    }
  }
  async getBrowser(agentId, options = {}) {
    if (
      typeof agentId !== 'string' ||
      !agentId ||
      !path.isAbsolute(options.profileDir ?? '') ||
      (options.mode && options.mode !== 'per-agent') ||
      options.cdpEndpoint
    )
      fail('EXPLICIT_MANAGED_PROFILE_REQUIRED');
    if (this.closingAll || this.closePromises.has(agentId)) fail('BROWSER_CLIENT_IS_CLOSING');
    const selection = path.resolve(options.profileDir);
    if (this.selections.has(agentId) && this.selections.get(agentId) !== selection)
      fail('BROWSER_SELECTION_CHANGED');
    if (this.pending.has(agentId)) return this.pending.get(agentId);
    const previous = this.liveInstances.get(agentId);
    if (previous && !previous.page.isClosed() && previous.browser.isConnected()) return previous;
    if (previous) await this.close(agentId);
    this.selections.set(agentId, selection);
    const operation = this.acquire(agentId, { ...options, profileDir: selection });
    this.pending.set(agentId, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(agentId);
      if (!this.liveInstances.has(agentId)) this.selections.delete(agentId);
    }
  }
  async acquire(agentId, options) {
    fs.mkdirSync(this.registry, { recursive: true, mode: 0o700 });
    fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    const profileDir = fs.realpathSync(options.profileDir);
    if (profileDir !== options.profileDir) fail('BROWSER_PROFILE_SYMLINK_UNSUPPORTED');
    const recordPath = browserRecordPath(profileDir),
      clientId = process.pid + '-' + randomUUID();
    let record;
    await withLock(recordPath + '.lock', async () => {
      record = readRecord(recordPath);
      if (record) {
        validateBrowserLease(record, { profileDir });
        record.clients = retainBrowserClients(record.clients);
        const current = disposition(record.process);
        if (current === 'unknown') fail('BROWSER_PROCESS_IDENTITY_UNOBSERVED');
        if (current === 'same') {
          if (!(await endpointAlive(record.endpoint))) fail('OWNED_BROWSER_ENDPOINT_UNAVAILABLE');
        } else {
          if (Object.keys(record.clients).length) fail('BROWSER_CLIENTS_STILL_ACTIVE');
          record = null;
        }
      }
      if (!record) {
        const existing = devtoolsFile(profileDir);
        if (existing && (await endpointAlive(existing))) fail('UNOWNED_BROWSER_PROFILE_IN_USE');
        record = await this.launch(profileDir, recordPath, options);
      }
      const identity = inspectBrowserProcess(process.pid);
      if (identity.state !== 'present') fail('BROWSER_CLIENT_IDENTITY_UNOBSERVED');
      record.clients[clientId] = { pid: process.pid, startId: identity.startId, agentId };
      atomic(recordPath, record);
    });
    let browser, page;
    const binding = { recordPath, clientId, profileDir, cdpEndpoint: record.endpoint, agentId };
    try {
      browser = await chromium.connectOverCDP(record.endpoint, { timeout: this.options.timeout ?? 15000 });
      const ctx = browser.contexts()[0];
      if (!ctx) fail('BROWSER_DEFAULT_CONTEXT_MISSING');
      page = await ctx.newPage();
      const instance = {
        ...binding,
        browser,
        ctx,
        page,
        mode: 'per-agent',
        managed: true,
        headless: record.headless,
        cdpPort: Number(endpointParts(record.endpoint).port),
      };
      this.liveInstances.set(agentId, instance);
      return instance;
    } catch (error) {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await this.release(binding).catch(() => {});
      throw error;
    }
  }
  async launch(profileDir, recordPath, options) {
    const executable = browserExecutable(this.options);
    const extra = this.options.extraArgs ?? [];
    if (
      !Array.isArray(extra) ||
      extra.some(
        (arg) =>
          typeof arg !== 'string' ||
          /^--(?:user-data-dir|remote-debugging-port|remote-debugging-address)(?:=|$)/.test(arg),
      )
    )
      fail('BROWSER_IDENTITY_ARGUMENT_OVERRIDE');
    const headless = options.headless ?? true,
      before = devtoolsFile(profileDir);
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      ...(headless ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
      ...(this.options.chromiumSandbox === false || process.env.KF_BOT_NO_SANDBOX === '1'
        ? ['--no-sandbox']
        : []),
      ...extra,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ];
    const fd = fs.openSync(recordPath + '.launch.log', 'a', 0o600);
    let child;
    try {
      child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', fd] });
    } finally {
      fs.closeSync(fd);
    }
    let launchError;
    child.on('error', (error) => {
      launchError = error;
    });
    child.unref();
    let binding;
    const deadline = Date.now() + (this.options.timeout ?? 15000);
    const recovery = {
      version: 2,
      profileDir,
      endpoint: null,
      managed: true,
      mode: 'per-agent',
      headless,
      clients: {},
      state: 'starting',
    };
    try {
      while (Date.now() < deadline) {
        if (launchError || child.exitCode !== null) fail('CHROMIUM_START_FAILED');
        const identity = inspectBrowserProcess(child.pid);
        if (!binding && identity.state === 'present' && identity.executable === executable) {
          binding = { pid: child.pid, startId: identity.startId, executable: identity.executable };
          recovery.process = binding;
          atomic(recordPath, recovery);
        }
        const endpoint = devtoolsFile(profileDir);
        if (binding && endpoint && endpoint !== before && (await endpointAlive(endpoint))) {
          if (disposition(binding) !== 'same') fail('BROWSER_PROCESS_IDENTITY_CHANGED');
          return { ...recovery, endpoint, state: 'ready' };
        }
        await sleep(75);
      }
      fail('CHROMIUM_START_TIMEOUT');
    } catch (error) {
      if (binding && (await stopOwnedProcess(binding, null))) {
        const current = readRecord(recordPath);
        if (current?.process?.pid === binding.pid && current.process.startId === binding.startId)
          fs.unlinkSync(recordPath);
      }
      throw error;
    }
  }
  async release(instance) {
    await withLock(instance.recordPath + '.lock', async () => {
      const record = validateBrowserLease(readRecord(instance.recordPath), {
        profileDir: instance.profileDir,
        endpoint: instance.cdpEndpoint,
        clientId: instance.clientId,
        agentId: instance.agentId,
        clientPid: process.pid,
      });
      const remaining = { ...record.clients };
      delete remaining[instance.clientId];
      const clients = retainBrowserClients(remaining);
      if (Object.keys(clients).length || this.options.keepAlive === true) {
        atomic(instance.recordPath, { ...record, clients });
        return;
      }
      // Keep the original client identity until exit is proved; failure is precisely retryable.
      if (!(await stopOwnedProcess(record.process, record.endpoint))) fail('BROWSER_EXIT_UNCONFIRMED');
      fs.unlinkSync(instance.recordPath);
      // User profiles and lock inodes are never removed by automatic retirement.
    });
  }
  async close(agentId) {
    if (this.closePromises.has(agentId)) return this.closePromises.get(agentId);
    const operation = (async () => {
      if (this.pending.has(agentId)) await this.pending.get(agentId).catch(() => {});
      const instance = this.liveInstances.get(agentId);
      if (!instance) return;
      await instance.page.close().catch(() => {});
      await instance.browser.close().catch(() => {});
      await this.release(instance);
      if (this.liveInstances.get(agentId) === instance) {
        this.liveInstances.delete(agentId);
        this.selections.delete(agentId);
      }
    })();
    this.closePromises.set(agentId, operation);
    try {
      return await operation;
    } finally {
      this.closePromises.delete(agentId);
    }
  }
  async closeAll() {
    if (this.closingAll) return this.closingAll;
    const operation = (async () => {
      await Promise.allSettled([...this.pending.values()]);
      const errors = [];
      for (const id of [...this.liveInstances.keys()])
        try {
          await this.close(id);
        } catch (error) {
          errors.push(error);
        }
      if (this.signal) {
        process.removeListener('SIGINT', this.signal);
        process.removeListener('SIGTERM', this.signal);
      }
      if (errors.length) throw new AggregateError(errors, 'BROWSER_RELEASE_UNCONFIRMED');
    })();
    this.closingAll = operation;
    try {
      return await operation;
    } finally {
      this.closingAll = null;
    }
  }
}
