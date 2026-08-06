import { zhHant } from './zh-Hant';
import { en } from './en';
import { ja } from './ja';
import { ko } from './ko';

/**
 * i18n 核心:純 TS 零相依(不 import electron),main / 各 renderer / selftest 共用。
 * 每個行程獨立持有 currentLocale:main 開機從 registry 解析,renderer 開機 invoke locale-get,
 * 切換時 main 廣播 locale-apply,各視窗各自 setLocale + 重繪。
 * 字典一語一檔:zh-Hant 是基準(MessageKey 由它推導),其餘三語以 satisfies 強制齊全——漏翻即編譯錯。
 */

export type Locale = 'zh-Hant' | 'en' | 'ja' | 'ko';
export type MessageKey = keyof typeof zhHant;

export const LOCALES: readonly Locale[] = ['zh-Hant', 'en', 'ja', 'ko'];

const DICTS: Record<Locale, Record<MessageKey, string>> = { 'zh-Hant': zhHant, en, ja, ko };

/** app.getLocale() / 任意 BCP47 → 四語之一:zh* 一律繁中;en/ja/ko 對應;其他退 en。 */
export function resolveLocale(systemLocale: string): Locale {
  const lower = systemLocale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-Hant';
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('ko')) return 'ko';
  return 'en';
}

let currentLocale: Locale = 'zh-Hant';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** <html lang> 與 toLocaleTimeString 用的 BCP47 對映。 */
export function bcp47(): string {
  return { 'zh-Hant': 'zh-TW', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' }[currentLocale];
}

/** 取字串 + {name} 插值。fallback:當前語 → zh-Hant(型別上保證完整)→ key 原文(保險,不 throw)。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTS[currentLocale][key] ?? zhHant[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}
