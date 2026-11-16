/** Exact names observed in the supported Chinese UI and the international TCO frontend.
 * Action names stay separate: pending Leave must never match Leave Game or Concede.
 */
export const KEYTEKI_UI_NAMES = Object.freeze({
  newGame: Object.freeze(['New Game', '新游戏']),
  start: Object.freeze(['Start', '开始']),
  join: Object.freeze(['Join', '加入']),
  leavePending: Object.freeze(['Leave', '离开']),
  leaveFinished: Object.freeze(['Leave Game', '离开游戏']),
  allowSpectators: Object.freeze(['Allow spectators', '允许观战']),
});

const BUTTON_CONTROLS = new Set(['newGame', 'start', 'join', 'leavePending', 'leaveFinished']);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function keytekiUiName(control) {
  if (!Object.hasOwn(KEYTEKI_UI_NAMES, control)) throw Error('UI_CONTROL_UNKNOWN');
  return new RegExp('^(?:' + KEYTEKI_UI_NAMES[control].map(escapeRegExp).join('|') + ')$', 'u');
}

/** Return a strict Playwright locator; never choose an arbitrary first matching control. */
export function keytekiUiButton(page, control) {
  if (!BUTTON_CONTROLS.has(control)) throw Error('UI_BUTTON_UNKNOWN');
  return page.getByRole('button', { name: keytekiUiName(control) });
}

/** The older pending UI sends no argument; current TCO sends exactly the bound room ID.
 * Match only these serialized event shapes. Do not decode authentication or accept other rooms.
 */
export function pendingLeaveFrameMatches(payload, gameId) {
  return (
    typeof gameId === 'string' &&
    gameId.length > 0 &&
    (payload === '42["leavegame"]' || payload === '42' + JSON.stringify(['leavegame', gameId]))
  );
}
