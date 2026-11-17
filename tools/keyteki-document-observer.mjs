/** Observe document replacement without treating SPA History API routing as replacement.
 * Chromium's public CDP session distinguishes Page.frameNavigated (a commit) from
 * Page.navigatedWithinDocument. Playwright's page.framenavigated combines both.
 */
const failure = code => Object.assign(Error(code), { code });
const fail = code => { throw failure(code); };
const validFrame = frame => frame && !frame.parentId &&
  typeof frame.id === 'string' && frame.id && typeof frame.loaderId === 'string' && frame.loaderId;

export function observePageDocuments(page, { onDocument = () => {}, onUnavailable = () => {}, timeoutMs = 45000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000)
    fail('PENDING_DOCUMENT_INITIALIZATION_DEADLINE_INVALID');
  let session = null, disposed = false, initialized = false, error = null, identity = null;
  let settled = false, resolveReady, rejectReady, timer;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Owners await this rejecting promise; aborted setup must not create an unhandled rejection.
  ready.catch(() => {});
  const unavailable = code => {
    initialized = false;
    if (error === null) { error = code; onUnavailable(code); }
    if (!settled) { settled = true; clearTimeout(timer); rejectReady(failure(error)); }
  };
  const detach = current => {
    current.off('Page.frameNavigated', navigated);
    current.off('close', closed);
    try { return Promise.resolve(current.detach()).catch(() => {}); }
    catch { return Promise.resolve(); }
  };
  const releaseSession = () => {
    const current = session;
    session = null;
    return current ? detach(current) : Promise.resolve();
  };
  const abandon = code => {
    disposed = true;
    unavailable(code); // Settle readiness before any possibly stalled protocol cleanup.
    void releaseSession();
  };
  const navigated = ({ frame, type } = {}) => {
    if (disposed || frame?.parentId) return;
    if (!validFrame(frame)) { abandon('PENDING_DOCUMENT_IDENTITY_UNVERIFIED'); return; }
    identity = { frameId: frame.id, loaderId: frame.loaderId, navigationType: type ?? 'Navigation' };
    // Never deduplicate by URL or loader: BFCache restoration may reuse both.
    onDocument({ ...identity });
  };
  const closed = () => { if (!disposed) abandon('PENDING_DOCUMENT_OBSERVER_CLOSED'); };
  timer = setTimeout(() => abandon('PENDING_DOCUMENT_OBSERVER_TIMEOUT'), timeoutMs);
  void (async () => {
    try {
      const created = await page.context().newCDPSession(page);
      if (disposed) { void detach(created); return; }
      session = created;
      // Install before enabling observation, retaining commits during initialization.
      session.on('Page.frameNavigated', navigated);
      session.on('close', closed);
      await session.send('Page.enable');
      if (disposed) return;
      const { frameTree } = await session.send('Page.getFrameTree');
      if (disposed) return;
      if (!validFrame(frameTree?.frame)) fail('PENDING_DOCUMENT_IDENTITY_UNVERIFIED');
      const frame = frameTree.frame;
      identity ??= { frameId: frame.id, loaderId: frame.loaderId, navigationType: 'initial' };
      initialized = true;
      settled = true;
      clearTimeout(timer);
      resolveReady();
    } catch (cause) {
      abandon(/^[A-Z0-9_]+$/.test(cause?.code ?? '') ? cause.code : 'PENDING_DOCUMENT_OBSERVER_UNAVAILABLE');
    }
  })();
  return {
    ready,
    assertReady() { if (!initialized) fail(error ?? 'PENDING_DOCUMENT_OBSERVER_NOT_READY'); },
    snapshot: () => ({ ready: initialized, error, identity: identity && { ...identity } }),
    dispose() {
      disposed = true;
      initialized = false;
      if (!settled) unavailable('PENDING_DOCUMENT_OBSERVER_CLOSED');
      clearTimeout(timer);
      return releaseSession();
    },
  };
}
