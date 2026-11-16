import { createKeytekiSocialSession, normalizeSocialText } from './keyteki-social-session.mjs';
import { keytekiSocialSnapshot } from './keyteki-social-projection.mjs';

/** Optional social sidecar. This module has no access to a gameplay send method. */
export function createBridgeSocial(options) {
  const sessions = new Map();
  const offered = new Map();
  const saved = new Map(Array.isArray(options.checkpoints) ? options.checkpoints : []);
  const keyFor = (data) => JSON.stringify([data.origin, data.gameId, data.playerName]);
  const checkpoint = (key, social) => {
    saved.set(key, social.exportCheckpoint());
    if (saved.size > 64) saved.delete(saved.keys().next().value);
  };
  function refresh(data) {
    const wire = options.manager.getSession(data);
    const state = options.manager.describe(data);
    const names = Object.keys(wire.latestRaw?.players ?? {});
    const opponentName = names.find((name) => name !== data.playerName);
    if (!opponentName) return null;
    const binding = {
      origin: data.origin,
      gameId: data.gameId,
      playerName: data.playerName,
      opponentName,
      ownerEpoch: state.ownerEpoch,
    };
    const key = keyFor(data);
    let social = sessions.get(key);
    if (social && social.binding.ownerEpoch !== String(binding.ownerEpoch)) {
      checkpoint(key, social);
      social.close();
      sessions.delete(key);
      offered.delete(key);
      social = null;
    }
    if (!social) {
      const strategy = options.strategies.get(data.playerName);
      social = createKeytekiSocialSession({
        binding,
        generate: options.generate,
        strategy: {
          mode: strategy.mode === 'code' ? 'code' : strategy.mode === 'model-all' ? 'llm' : 'mixed',
          name: strategy.codePolicy,
        },
        knownBotNames: options.knownBotNames,
        policy: options.policy,
        checkpoint: saved.get(key),
        onEvent: (event) => options.onEvent?.({ ...event, gameId: data.gameId, playerName: data.playerName }),
      });
      sessions.set(key, social);
    }
    const ready =
      state.resumeReady !== false &&
      !wire.blocked &&
      !['detached', 'paused', 'awaiting-send-outcome', 'send-outcome-unknown', 'error'].includes(
        state.status,
      ) &&
      wire.latestRaw?.players[data.playerName]?.disconnected !== true;
    social.observe(keytekiSocialSnapshot(wire, binding, ready));
    return { social, binding, key };
  }
  return {
    observe(data) {
      return refresh(data)?.social.status() ?? null;
    },
    next(data) {
      const current = refresh(data);
      if (!current) return null;
      const packet = current.social.takeReady(current.binding);
      if (packet) checkpoint(current.key, current.social);
      if (packet) offered.set(current.key, packet);
      return packet;
    },
    authorize(data) {
      const current = refresh(data);
      const packet = current && offered.get(current.key);
      if (
        !packet ||
        packet.messageId !== data.messageId ||
        !current.social.isCurrent(packet, current.binding) ||
        normalizeSocialText(packet.text) !== packet.text
      )
        throw Error('Social message no longer current');
      offered.delete(current.key);
      return { packet, authorized: true };
    },
    settle(data) {
      const current = refresh(data);
      if (!current) return false;
      const settled = current.social.settle(data.messageId, data.outcome);
      if (offered.get(current.key)?.messageId === data.messageId) offered.delete(current.key);
      checkpoint(current.key, current.social);
      return settled;
    },
    suspend(data) {
      const key = keyFor(data),
        social = sessions.get(key);
      offered.delete(key);
      if (social) {
        checkpoint(key, social);
        social.close();
        sessions.delete(key);
      }
    },
    exportCheckpoint() {
      for (const [key, social] of sessions) checkpoint(key, social);
      return [...saved];
    },
    summary() {
      return [...sessions.values()].map((social) => ({ ...social.binding, ...social.status() }));
    },
    close() {
      for (const [key, social] of sessions) {
        checkpoint(key, social);
        social.close();
      }
      sessions.clear();
      offered.clear();
    },
  };
}
