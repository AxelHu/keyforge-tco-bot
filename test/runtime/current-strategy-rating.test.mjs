import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STRATEGY_ELO_BENCHMARK } from '../../tools/strategy-benchmark.mjs';
import { collectRuntimeFiles } from '../../tools/freeze-keyteki-live.mjs';
import { CURRENT_RATING_FILE } from '../../tools/current-strategy-rating.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-rating-menu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['tools', 'dist/src', 'docs/data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ['strategy-menu.mjs', 'current-strategy-rating.mjs', 'strategy-benchmark.mjs'])
    fs.copyFileSync(new URL('../../tools/' + name, import.meta.url), path.join(root, 'tools', name));
  for (const name of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(root, name), '{}');
  function snapshot() {
    const probe = [
      "import * as menu from './tools/strategy-menu.mjs';",
      "const entries = menu.strategyMenu({ all:true }).strategies;",
      "console.log(JSON.stringify({ entries, details: entries.map(menu.renderStrategyDetails), list:menu.renderStrategyMenu(menu.strategyMenu()) }));",
    ].join('\n');
    const data = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd:root, encoding:'utf8' }));
    return {
      row: id => data.entries.find(entry => entry.policyId === id),
      detail: id => data.details[data.entries.findIndex(entry => entry.policyId === id)],
      list: data.list,
    };
  }
  return { root, file: path.join(root, CURRENT_RATING_FILE), snapshot };
}

test('frozen menu falls back to its historical rows when the optional current panel is absent', (t) => {
  const f = fixture(t);
  const menu = f.snapshot();
  const row = menu.row('tactical-style-engine-v3');
  assert.equal(row.currentRating, null);
  assert.equal(row.ratedVersion, null);
  assert.equal(row.ratedSourceCommit, null);
  assert.equal(row.historicalRating.date, '2026-11-13');
  assert.match(menu.list, /历史 Elo/);
  assert.ok(!collectRuntimeFiles(f.root, { includeDependencies: false }).some((x) => x.path === CURRENT_RATING_FILE));
});

test('list and show render dated current ratings and retain the independent historical panel', (t) => {
  const f = fixture(t);
  const rows = [...STRATEGY_ELO_BENCHMARK.rows.map((r) => ({ ...r, elo: 1500 })),
    { policyId: 'tactical-card-effects-v3', label: '公开效果 V3', elo: 1501, low95: null, high95: null, wins: 150, losses: 138, games: 288 }];
  const current = { id:'strategy-elo-20261118', date:'2026-11-18', sourceCommit:'a'.repeat(40), ratedVersion:'0.6.5', rows };
  fs.writeFileSync(f.file, JSON.stringify(current));
  const menu = f.snapshot();
  const both = menu.row('tactical-toc-v2');
  assert.equal(both.currentRating.elo, 1500);
  assert.equal(both.ratedSourceCommit, current.sourceCommit);
  assert.equal(both.ratedVersion, current.ratedVersion);
  assert.equal(both.historicalRating.elo, STRATEGY_ELO_BENCHMARK.rows[0].elo);
  assert.match(menu.list, /当前 Elo 1500\.0/);
  const detail = menu.detail(both.policyId);
  for (const expected of ['2026-11-18', 'v0.6.5', current.sourceCommit, '历史同池 Elo']) assert.ok(detail.includes(expected));
  const seventh = menu.row('tactical-card-effects-v3');
  assert.equal(seventh.historicalRating, null);
  assert.equal(seventh.currentRating.elo, 1501);
  assert.match(menu.detail(seventh.policyId), /区间未估计/);
  const unranked = menu.row('random');
  assert.equal(unranked.currentRating, null);
  assert.match(menu.detail(unranked.policyId), /未列入 2026-11-18/);
  fs.writeFileSync(path.join(f.root, 'docs/data/unrelated.json'), '{}');
  const docs = collectRuntimeFiles(f.root, { includeDependencies: false }).filter((x) => x.path.startsWith('docs/'));
  assert.deepEqual(docs.map((row) => row.path), [CURRENT_RATING_FILE]);
});

test('frozen aggregate rejects symlinks in the optional rating path', (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.root, 'docs/data'), path.join(f.root, 'elsewhere'));
  fs.symlinkSync('../elsewhere', path.join(f.root, 'docs/data'));
  assert.throws(() => collectRuntimeFiles(f.root, { includeDependencies: false }), /RUNTIME_SYMLINK_UNSUPPORTED/);
});
