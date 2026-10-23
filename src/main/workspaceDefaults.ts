import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 新寵物預設工作目錄:在 <根位置>/<消毒後寵物名>_<建立時間>/ 建一個專屬資料夾,
 *  避免使用者忘記選目錄造成工作區污染。純函式與 fs 包裝分層,純函式供 selftest 直接驗證。 */

/** 檔名消毒:去掉跨平台不合法字元與控制字元;空白直接移除(「寵物 3」→「寵物3」);
 *  頭尾的點去掉(避免隱藏檔);截 60 字;全空時退回 'pet'。 */
export function sanitizeWorkspaceName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 60);
  return cleaned || 'pet';
}

/** 時間戳:本地時間 YYYY-MM-DD_HH-mm-ss(例:2026-08-06_14-30-52)。 */
export function formatWorkspaceTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${ymd}_${hms}`;
}

/** 組出不碰撞的資料夾名:時間戳到秒,同秒連建才會撞,撞了加 -2、-3…。 */
export function resolveWorkspaceDirName(
  name: string,
  date: Date,
  exists: (dirName: string) => boolean
): string {
  const base = `${sanitizeWorkspaceName(name)}_${formatWorkspaceTimestamp(date)}`;
  let candidate = base;
  for (let n = 2; exists(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** 建立預設工作目錄,回傳絕對路徑;任何失敗(根位置唯讀、磁碟拔除等)回 null,
 *  呼叫端 fallback 成「未設定工作目錄」的原行為(bridge 會提示使用者手動選)。 */
export function createDefaultWorkspace(root: string, petName: string, now = new Date()): string | null {
  try {
    mkdirSync(root, { recursive: true });
    const dirName = resolveWorkspaceDirName(petName, now, (d) => existsSync(join(root, d)));
    const full = join(root, dirName);
    mkdirSync(full); // 不 recursive:同名恰被別的行程建走時丟 EEXIST 落入 catch
    return full;
  } catch (error) {
    console.log('[main] 建立預設工作目錄失敗,寵物維持未設定目錄:', error);
    return null;
  }
}

/** 首次啟動、舊角色與新增角色共用：只補尚未設定的工作目錄。
 *  已有路徑即使暫時不存在也保留，避免外接磁碟離線時被換成另一個工作區。
 *  建立成功才更新角色；失敗時留待下次啟動重試。回傳是否需要儲存設定。 */
export function ensurePetWorkspace(
  root: string,
  profile: { name: string; workspacePath?: string },
): boolean {
  if (typeof profile.workspacePath === 'string' && profile.workspacePath.trim()) return false;
  const workspace = createDefaultWorkspace(root, profile.name);
  if (!workspace) return false;
  profile.workspacePath = workspace;
  return true;
}
