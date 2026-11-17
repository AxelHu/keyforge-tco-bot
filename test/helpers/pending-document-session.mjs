import { EventEmitter } from 'node:events';

/** CDP-only test double. Main-frame commits and same-document routing are distinct events. */
export function mockPendingDocumentSession(page, options = {}) {
  const session = new EventEmitter();
  session.calls = [];
  session.detaches = 0;
  session.frame = { id: 'fixture-main-frame', loaderId: 'fixture-loader', url: 'about:blank' };
  session.send = async method => {
    session.calls.push(method);
    const supplied = await options.send?.(method, session);
    if (supplied !== undefined) return supplied;
    return method === 'Page.getFrameTree' ? { frameTree: { frame: { ...session.frame } } } : {};
  };
  session.detach = async () => { session.detaches++; session.emit('close'); };
  const context = typeof page.context === 'function' ? page.context() : {};
  page.context = () => ({ ...context, newCDPSession: async target => {
    if (target !== page) throw Error('WRONG_PAGE_SESSION');
    await options.create?.(session);
    return session;
  } });
  const mainFrame = {};
  page.mainFrame ??= () => mainFrame;
  return session;
}
