/** Release exactly the known managed lease after the caller has proved native room departure. */
import fs from 'node:fs';
import { humanBrowserAgentId } from './browser-paths.mjs';

const changed = () => {
  throw Object.assign(Error('OWNED_BROWSER_LEASE_CHANGED'), { code: 'OWNED_BROWSER_LEASE_CHANGED' });
};
export async function releaseOwnedHumanBrowser({
  pool,
  instance,
  config,
  readRecord = (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
}) {
  const agentId = humanBrowserAgentId(config.output);
  if (
    !instance ||
    instance.agentId !== agentId ||
    instance.managed !== true ||
    instance.profileDir !== config.browserProfile ||
    !instance.cdpEndpoint ||
    typeof instance.recordPath !== 'string' ||
    !instance.recordPath ||
    typeof instance.clientId !== 'string' ||
    !instance.clientId ||
    pool?.liveInstances?.get(agentId) !== instance ||
    !pool.options ||
    typeof pool.close !== 'function'
  )
    changed();
  let record;
  try {
    record = readRecord(instance.recordPath);
  } catch {
    changed();
  }
  if (
    record?.managed !== true ||
    record.profileDir !== instance.profileDir ||
    record.profileDir !== config.browserProfile ||
    record.endpoint !== instance.cdpEndpoint ||
    record.clients?.[instance.clientId]?.agentId !== agentId ||
    record.clients[instance.clientId].pid !== process.pid
  )
    changed();
  const previous = pool.options.keepAlive;
  try {
    // AgentBrowser's scoped close retains other live clients and verifies its owned process.
    pool.options.keepAlive = false;
    await pool.close(agentId);
    return { leaseReleased: true, managed: true, agentId };
  } finally {
    pool.options.keepAlive = previous;
  }
}
