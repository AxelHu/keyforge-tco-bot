import { readFileSync } from 'node:fs';

export const CURRENT_RATING_FILE = 'docs/data/strategy-elo-20261118.json';
const aggregate = new URL('../' + CURRENT_RATING_FILE, import.meta.url);
let cached;

export function currentStrategyBenchmark() {
  if (cached !== undefined) return cached;
  let bytes;
  try {
    bytes = readFileSync(aggregate, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return (cached = null);
  }
  const data = JSON.parse(bytes);
  if (data.id !== 'strategy-elo-20261118' || data.date !== '2026-11-18' ||
      !/^[a-f0-9]{40}$/.test(data.sourceCommit) || !/^\d+\.\d+\.\d+$/.test(data.ratedVersion) ||
      !Array.isArray(data.rows) || data.rows.length !== 7 ||
      new Set(data.rows.map((row) => row.policyId)).size !== data.rows.length ||
      !data.rows.every((row) => typeof row.policyId === 'string' && Number.isFinite(row.elo) &&
        ((Number.isFinite(row.low95) && Number.isFinite(row.high95) && row.low95 <= row.high95) ||
        (row.low95 === null && row.high95 === null)) &&
        [row.games, row.wins, row.losses].every((value) => Number.isSafeInteger(value) && value >= 0) &&
        row.games > 0 && row.wins + row.losses === row.games))
    throw Error('CURRENT_STRATEGY_RATING_INVALID');
  cached = data;
  return cached;
}
