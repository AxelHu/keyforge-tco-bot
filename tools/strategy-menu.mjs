/** 用户策略入口。注册快照由真实 CODE_POLICY_IDS 导出；离线回归核对完整顺序，不能独立增删。 */
import { STRATEGY_ELO_BENCHMARK } from './strategy-benchmark.mjs';

export const DEFAULT_CODE_POLICY = 'tactical-style-engine-v3';
export const REGISTERED_CODE_POLICY_IDS = Object.freeze([
  "tactical-card-aware-v3",
  "tactical-card-effects-v3",
  "tactical-card-aware-v2",
  "tactical-card-effects-v1",
  "tactical-card-aware-v1",
  "tactical-dok-card-v1",
  "tactical-dok-deck-v1",
  "tactical-dok-combined-v1",
  "tempo-prophecy-guided-v5",
  "tactical-prophecy-guided-v5",
  "economy-prophecy-guided-v5",
  "tullibint-well-island-guided-v5",
  "tempo-prophecy-guided-v4",
  "tactical-prophecy-guided-v4",
  "economy-prophecy-guided-v4",
  "tullibint-well-island-guided-v4",
  "tempo-ladder-sequence",
  "tempo-ladder-income",
  "tempo-ladder-reserve",
  "tempo-ladder-threat",
  "tempo-ladder-balanced",
  "tactical-ladder-sequence",
  "tactical-ladder-income",
  "tactical-ladder-reserve",
  "tactical-ladder-threat",
  "tactical-ladder-balanced",
  "economy-ladder-sequence",
  "economy-ladder-income",
  "economy-ladder-reserve",
  "economy-ladder-threat",
  "economy-ladder-balanced",
  "tempo-season-v1",
  "tactical-season-v1",
  "economy-season-v1",
  "tempo-season-v2",
  "tactical-season-v2",
  "economy-season-v2",
  "tempo-season-v3",
  "tactical-season-v3",
  "economy-season-v3",
  "tullibint-well-island-core-v3",
  "tullibint-well-island-burst-v3",
  "tullibint-well-island-sequence-v3",
  "tullibint-well-island-v2",
  "tullibint-well-island-patient-v2",
  "tullibint-well-island-cycle-v2",
  "tullibint-engine-v1",
  "tullibint-conservative-v1",
  "random",
  "explore",
  "greedy",
  "tempo",
  "tactical",
  "economy",
  "style-race",
  "style-control",
  "style-develop",
  "style-combo",
  "tactical-v2",
  "tempo-v2",
  "economy-v2",
  "race-v2",
  "control-v2",
  "adaptive-v2",
  "tactical-v3",
  "tempo-v3",
  "economy-v3",
  "race-v3",
  "control-v3",
  "adaptive-v3",
  "tactical-v4",
  "tempo-v4",
  "economy-v4",
  "race-v4",
  "control-v4",
  "adaptive-v4",
  "tactical-toc-token-v1",
  "tactical-toc-locks-v1",
  "tactical-toc-v1",
  "tactical-style-cycle-v1",
  "tactical-style-engine-v1",
  "tactical-style-control-v1",
  "tactical-style-engine-v2",
  "tactical-ladder-balanced-v2",
  "tactical-card-effects-v4",
  "tactical-toc-v2",
  "tactical-style-cycle-v2",
  "tactical-style-engine-v3",
  "tactical-style-control-v2"
]);
const registered = new Set(REGISTERED_CODE_POLICY_IDS);
export const COMMON_STRATEGIES = Object.freeze([
  Object.freeze({ policyId: 'tactical-style-engine-v3', label: '场面引擎 V3', description: '优先兑现已在场的生物、神器和现成资源；当前启动默认。' }),
  Object.freeze({ policyId: 'tactical-toc-v2', label: 'ToC V2', description: '兼顾 Token 经济、收获限制与阵营可用工作；历史面板点估计最高。' }),
  Object.freeze({ policyId: 'tactical-style-cycle-v2', label: '循环抢速 V2', description: '偏重过牌与档案补手，适合尝试快周转风格。' }),
  Object.freeze({ policyId: 'tactical-card-effects-v4', label: '公开效果 V4', description: '按公开卡牌效果、阵营机会和可用工作排序的通用候选。' }),
  Object.freeze({ policyId: 'tactical-style-control-v2', label: '干扰控制 V2', description: '偏重干扰和阻止对手铸钥，同时衡量战斗与收获的机会成本。' }),
]);
const common = new Map(COMMON_STRATEGIES.map((row) => [row.policyId, row]));
const fail = (code) => { throw Object.assign(Error(code), { code }); };
export const isRegisteredCodePolicy = (id) => typeof id === 'string' && registered.has(id);
export function assertRegisteredCodePolicy(id) {
  if (!isRegisteredCodePolicy(id)) fail('CODE_POLICY_UNAVAILABLE');
  return id;
}
export function strategyDetails(id) {
  assertRegisteredCodePolicy(id);
  const preferred = common.get(id);
  const row = STRATEGY_ELO_BENCHMARK.rows.find((entry) => entry.policyId === id);
  let group = 'advanced';
  let description = '历史基线、实验版本或高级扩展；注册存在不代表与常用项同等推荐。';
  if (id.startsWith('tullibint-')) {
    group = 'specialized';
    description = 'Tullibint 专牌与井/岛组合实验；需匹配其公开卡牌构成，不是任意牌组的通用升级。';
  } else if (id.includes('-prophecy-') || id.includes('-season-')) {
    group = 'specialized';
    description = '针对预言、季度或潮汐机制的候选；请按牌组机制选择，不能按版本数字判断强弱。';
  } else if (id.startsWith('tactical-dok-')) {
    description = '高级 DoK 特征扩展；需调用方注入 CodeStrategyContext，CLI 不会自动获取外部评级数据。';
  } else if (id === 'tactical-ladder-balanced-v2') {
    description = '保留的历史均衡对照；在该历史六候选面板中 Elo 点估计最低，默认常用菜单不展示。';
  } else if (['random', 'explore', 'greedy'].includes(id)) {
    description = '用于开发、探索或对照的基线，不作为常用对战入口。';
  }
  return {
    policyId: id,
    label: preferred?.label ?? row?.label ?? id,
    group: preferred ? 'common' : group,
    default: id === DEFAULT_CODE_POLICY,
    description: preferred?.description ?? description,
    historicalRating: row ? {
      datasetId: STRATEGY_ELO_BENCHMARK.id,
      date: STRATEGY_ELO_BENCHMARK.date,
      sourceCommit: STRATEGY_ELO_BENCHMARK.sourceCommit,
      currentImplementationMayDiffer: true,
      elo: row.elo, low95: row.low95, high95: row.high95,
      wins: row.wins, losses: row.losses, games: row.games,
    } : null,
  };
}
export function strategyMenu({ all = false } = {}) {
  const ids = all
    ? [...COMMON_STRATEGIES.map((row) => row.policyId), ...REGISTERED_CODE_POLICY_IDS.filter((id) => !common.has(id))]
    : COMMON_STRATEGIES.map((row) => row.policyId);
  return {
    schema: 'kf-strategy-menu-v1', view: all ? 'all' : 'common',
    defaultPolicy: DEFAULT_CODE_POLICY, registeredCount: REGISTERED_CODE_POLICY_IDS.length,
    shownCount: ids.length,
    benchmarkNote: 'Elo 为 2026-11-13 冻结实现的历史本地同池测试；当前实现有修补，非当前公开包或 TCO 新测评级。',
    strategies: ids.map(strategyDetails),
  };
}
export function resolveStrategyChoice(answer) {
  const value = String(answer).trim();
  if (!value) return DEFAULT_CODE_POLICY;
  if (/^[1-9][0-9]*$/.test(value)) return COMMON_STRATEGIES[Number(value) - 1]?.policyId;
  return isRegisteredCodePolicy(value) ? value : undefined;
}
export function renderStrategyMenu(menu) {
  const groups = { common: '常用', specialized: '专项', advanced: '历史/实验/高级' };
  const lines = [
    `已注册 ${menu.registeredCount} 个代码策略；当前显示 ${menu.shownCount} 个${menu.view === 'all' ? '完整选项' : '常用选项'}。`,
    `启动默认：${menu.defaultPolicy}`, menu.benchmarkNote, '',
  ];
  menu.strategies.forEach((row, i) => {
    const score = row.historicalRating ? `；历史 Elo ${row.historicalRating.elo.toFixed(1)}` : '';
    lines.push(`${i + 1}. ${row.label}${row.default ? '（默认）' : ''} [${groups[row.group]}${score}]`);
    lines.push(`   ${row.policyId}`);
    lines.push(`   ${row.description}`);
  });
  lines.push('', '查看全部：kf-auto strategies list --all', '查看详情：kf-auto strategies show ID',
    '新建配置时选择：kf-auto init ... --policy ID，或使用 --choose-policy 交互选择。',
    '已开始的连续对局绑定策略配置；这些查询不会修改现有配置或切换运行中的策略。');
  return lines.join('\n');
}
export function renderStrategyDetails(row) {
  const lines = [row.label + (row.default ? '（当前启动默认）' : ''), `策略 ID：${row.policyId}`, row.description];
  if (row.historicalRating) {
    const h = row.historicalRating;
    lines.push(`历史同池 Elo：${h.elo.toFixed(1)}；名义 95% 完整块区间 ${h.low95.toFixed(1)}–${h.high95.toFixed(1)}`,
      `跨策略结果：${h.wins} 胜 ${h.losses} 负 / ${h.games} 局`,
      `冻结源码：${h.sourceCommit}`, '此为 2026-11-13 本地模拟结果；当前实现有更新，不代表当前公开包或 TCO 新测评级。');
  } else lines.push('未列入 2026-11-13 六候选同池榜；不能把缺少该分数解释为强弱结论。');
  lines.push(`新建配置参数：--policy ${row.policyId}`, '说明：docs/strategy-guide.md');
  return lines.join('\n');
}
