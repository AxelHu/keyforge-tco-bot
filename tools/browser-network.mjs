/** Explicit Chromium routing. This does not change the machine's proxy or VPN settings. */
const fail = () => {
  throw Object.assign(Error('BROWSER_NETWORK_INVALID'), { code: 'BROWSER_NETWORK_INVALID' });
};

export function normalizeBrowserNetwork(value = { mode: 'system' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['mode', 'server'].includes(key)) ||
      !['system', 'direct', 'proxy'].includes(value.mode)) fail();
  if (value.mode !== 'proxy') {
    if (Object.hasOwn(value, 'server')) fail();
    return Object.freeze({ mode: value.mode });
  }
  // One proxy endpoint, never credentials, a PAC URL, a list, or arbitrary browser switches.
  if (typeof value.server !== 'string' || value.server.length > 300 ||
      !/^(?:https?|socks5):\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?\/?$/.test(value.server)) fail();
  let server;
  try { server = new URL(value.server); } catch { fail(); }
  if (!server.hostname || server.username || server.password || server.search || server.hash ||
      !['', '/'].includes(server.pathname) || server.port === '0') fail();
  return Object.freeze({ mode: 'proxy', server: server.protocol + '//' + server.host });
}

export function browserNetworkArgs(value) {
  const network = normalizeBrowserNetwork(value);
  if (network.mode === 'system') return [];
  if (network.mode === 'direct') return ['--no-proxy-server'];
  // Local CDP and strategy-host requests keep Chromium's loopback bypass.
  return ['--proxy-server=' + network.server, '--proxy-bypass-list=localhost;127.0.0.1;[::1]'];
}
