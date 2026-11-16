/** Table-language policy is independent of strategy decisions and of optional model availability. */
export const CHAT_LANGUAGES = Object.freeze(['zh-CN', 'en']);
export function normalizeChatLanguage(value, origin) {
  if (value !== undefined) {
    if (!CHAT_LANGUAGES.includes(value)) throw Object.assign(Error('CHAT_LANGUAGE_INVALID'), { code: 'CHAT_LANGUAGE_INVALID' });
    return value;
  }
  let hostname;
  try { hostname = new URL(origin).hostname; } catch {}
  // Exact hostname only: another deployment or a lookalike domain keeps the existing default.
  return hostname === 'thecrucible.online' ? 'en' : 'zh-CN';
}
export const WATCHDOG_APOLOGIES = Object.freeze({
  'zh-CN': '抱歉，我这边的自动对战程序卡住了，恢复没有成功。这局我认输，不耽误你时间。',
  en: "Sorry, my automated player got stuck and recovery failed. I'm conceding this game so I don't keep you waiting.",
});
export const watchdogApology = (language, origin) => WATCHDOG_APOLOGIES[normalizeChatLanguage(language, origin)];
