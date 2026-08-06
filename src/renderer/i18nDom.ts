import { bcp47, t, type MessageKey } from '../shared/i18n';

/** 掃描 data-i18n 屬性套用翻譯到靜態 DOM;開機與每次 locale-apply 各跑一次。
 *  HTML 標籤內保留原繁中文字當 fallback 兼可讀性,本函式會覆寫。 */
export function applyI18nDom(root: ParentNode = document): void {
  document.documentElement.lang = bcp47();
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset['i18n'] as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((element) => {
    element.title = t(element.dataset['i18nTitle'] as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((element) => {
    (element as HTMLInputElement | HTMLTextAreaElement).placeholder =
      t(element.dataset['i18nPlaceholder'] as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset['i18nAriaLabel'] as MessageKey));
  });
}
