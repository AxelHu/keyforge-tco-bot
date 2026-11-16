/** Optional table-chat credential. Never reads a home directory or global account store. */
export function configuredMinimaxKey(env = process.env) {
  const key = env.MINIMAX_API_KEY;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
    throw Error('MINIMAX_API_KEY_REQUIRED_FOR_ENABLED_SOCIAL');
  return key;
}
