import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const BROWSER_NAMESPACE = 'keyforge-tco-bot';
export function browserProfileRoot(env = process.env, home = os.homedir()) {
  return path.resolve(env.KF_BOT_BROWSER_ROOT || path.join(home, '.cache', BROWSER_NAMESPACE, 'browsers'));
}
export function browserRegistryRoot(env = process.env, home = os.homedir()) {
  return path.resolve(
    env.KF_BOT_BROWSER_REGISTRY || path.join(browserProfileRoot(env, home), '.registry-v2'),
  );
}
export function browserRecordPath(profileDir, env = process.env, home = os.homedir()) {
  if (!path.isAbsolute(profileDir)) throw Error('BROWSER_PROFILE_MUST_BE_ABSOLUTE');
  return path.join(
    browserRegistryRoot(env, home),
    createHash('sha256')
      .update('profile:' + profileDir)
      .digest('hex') + '.json',
  );
}
export function humanBrowserAgentId(output) {
  return BROWSER_NAMESPACE + ':human-' + path.basename(output);
}
export function campaignAccountLockRoot(home = os.homedir()) {
  return path.join(home, '.cache', BROWSER_NAMESPACE, 'accounts');
}
