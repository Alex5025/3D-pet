import { desktopCapturer, screen, systemPreferences } from 'electron';
import type { ScreenCaptureResult } from '../shared/chat';
import { t } from '../shared/i18n';

let capturing = false;

/** 手動附件與 AI 工具共用同一個擷取鎖；圖片只回傳給呼叫端，不另存檔。 */
export async function captureScreen(): Promise<ScreenCaptureResult> {
  if (capturing) return { ok: false, reason: t('screen.busy') };
  capturing = true;
  try { return await captureDisplay(); }
  finally { capturing = false; }
}

/** 單次擷取游標所在的螢幕。 */
async function captureDisplay(): Promise<ScreenCaptureResult> {
  const permissionDenied = (): boolean => process.platform === 'darwin'
    && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'));
  const denied = (): ScreenCaptureResult => ({ ok: false, reason: t('screen.permissionRequired') });
  try {
    if (permissionDenied()) return denied();
    // 在等待系統權限之前記住目標，避免游標移動後擷取另一個螢幕。
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2560, height: 2560 },
      fetchWindowIcons: false,
    });
    // macOS 未授權時有機會回傳只有桌布的圖片，不應當作成功。
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return denied();
    const source = sources.find((item) => item.display_id === String(display.id))
      ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return { ok: false, reason: t('screen.unavailable') };
    const bytes = source.thumbnail.toJPEG(90);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return { ok: false, reason: t('screen.unavailable') };
    return {
      ok: true,
      image: { mimeType: 'image/jpeg', data: bytes.toString('base64'), name: `screen-${display.id}-${Date.now()}.jpg` },
    };
  } catch {
    return permissionDenied() ? denied() : { ok: false, reason: t('screen.failed') };
  }
}
