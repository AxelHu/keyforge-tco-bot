/** Exact origin syntax only; an accepted URL is not a claim of tested site compatibility. */
export function exactSiteOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(Error('EXPLICIT_SITE_ORIGIN_REQUIRED'), { code: 'EXPLICIT_SITE_ORIGIN_REQUIRED' });
  }
  if (
    typeof value !== 'string' ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw Object.assign(Error('EXACT_SITE_ORIGIN_REQUIRED'), { code: 'EXACT_SITE_ORIGIN_REQUIRED' });
  return value;
}

/** Optional exact cross-origin node endpoints; no host, port, node or wildcard is inferred. */
export function normalizeGameSocketPaths(value = []) {
  if (!Array.isArray(value) || value.length > 32) throw Error('GAME_SOCKET_PATHS_INVALID');
  const result = value.map((entry) => {
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw Error('GAME_SOCKET_PATH_INVALID');
    }
    if (
      typeof entry !== 'string' ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_-]{1,80}\/socket\.io$/.test(url.pathname) ||
      entry !== url.origin + url.pathname
    )
      throw Error('GAME_SOCKET_PATH_INVALID');
    return entry;
  });
  return [...new Set(result)];
}
