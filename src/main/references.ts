import { BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface ReferencesDeps {
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly win: BrowserWindow | null;
  readonly pushVrm: (petId: string, path: string) => Promise<void>;
}

/** references 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createReferences(deps: ReferencesDeps) {
  const scope = createResourceScope();

  /* ── 參考檔案(拖放到寵物身上;當次對話有效,純記憶體不落盤)──
   * renderer 經 webUtils 取絕對路徑送來;這裡 stat 驗證存在、判資料夾,注入走 bridge 的 turnOpts。 */
  const refKey = (id: string, workspacePath = deps.getPet(id)?.workspacePath): string => JSON.stringify([id, workspacePath]);

  const petRefFiles = new Map<string, { path: string; isDir: boolean; }[]>();

  const sendRefFiles = (petId: string): void =>
    deps.win?.webContents.send('ref-files-apply', petId, petRefFiles.get(refKey(petId)) ?? []);

  const addReferencePaths = async (petId: string, paths: string[]): Promise<void> => {
    const key = refKey(petId);
    const list = petRefFiles.get(key) ?? [];
    let changed = false;
    for (const path of paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p))) {
      // .vrm/.vrma 維持原本拖放語意(換模型/播動作)——疊層收不到拖放後,接收窗是它們唯一的拖放入口
      const lower = path.toLowerCase();
      if (lower.endsWith('.vrm')) {
        void deps.pushVrm(petId, path);
        continue;
      }
      if (lower.endsWith('.vrma')) {
        try {
          deps.win?.webContents.send('vrma-play', petId, await readFile(path));
        } catch { /* 檔案讀不到就略過 */ }
        continue;
      }
      if (list.some((item) => item.path === path) || list.length >= 20) continue;
      try {
        list.push({ path, isDir: (await stat(path)).isDirectory() });
        changed = true;
      } catch {
        console.log('[main] 參考檔不存在,略過:', path);
      }
    }
    if (changed) {
      petRefFiles.set(key, list);
      sendRefFiles(petId);
    }
  };
  function start() {
    if (!scope.start()) return;

  }
  return {
    get sendRefFiles() { return sendRefFiles; },
    get petRefFiles() { return petRefFiles; },
    get refKey() { return refKey; },
    get addReferencePaths() { return addReferencePaths; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type References = ReturnType<typeof createReferences>;
