import { BrowserWindow } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../shared/i18n';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface MotionsDeps {
  readonly motionsDir: () => string;
  readonly pets: Map<string, PetProfile>;
  readonly isIdleMotionPaused: () => boolean;
  readonly win: BrowserWindow | null;
  readonly updatePet: (id: string, patch: Partial<PetProfile>) => PetProfile | null;
  readonly refreshTray: () => void;
  readonly sendPetProfiles: () => void;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
}

/** motions 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createMotions(deps: MotionsDeps) {
  const scope = createResourceScope();

  let motionsWatcher: FSWatcher | null = null;

  let motionFiles: string[] = [];

  let motionsDirMissing = false;

  async function refreshMotions(): Promise<void> {
    try {
      motionFiles = (await readdir(deps.motionsDir()))
        .filter((file) => file.toLowerCase().endsWith('.vrma'))
        .sort();
      motionsDirMissing = false;
    } catch {
      motionFiles = [];
      motionsDirMissing = true;
    }
  }

  /* ── 待機動作:每寵一個 timer,20~60 秒隨機間隔從勾選清單挑一個播放 ──
   * 排程長駐、播放前才檢查當下狀態(啟用/清單/功率檔位),設定改完即生效、不用追著清 timer。 */
  const IDLE_MOTION_MIN_MS = 20_000;

  const IDLE_MOTION_SPAN_MS = 40_000;

  const idleMotionTimers = new Map<string, NodeJS.Timeout>();

  /** 全域錯開:同一時間只有一寵播待機動作(多寵同時全速跑會疊 GPU;輪流動也更自然)。
   *  動作長度 main 不知道,以保守窗口互斥;撞到的寵物順延重排。 */
  let idleMotionBusyUntil = 0;

  const IDLE_MOTION_LOCK_MS = 10_000;

  function cancelIdleMotion(id: string): void {
    const timer = idleMotionTimers.get(id);
    if (timer) scope.clearTimeout(timer);
    idleMotionTimers.delete(id);
  }

  function scheduleIdleMotion(petId: string): void {
    if (scope.disposed) return;
    const old = idleMotionTimers.get(petId);
    if (old) scope.clearTimeout(old);
    idleMotionTimers.delete(petId);
    const profile = deps.pets.get(petId);
    if (!profile || profile.enabled === false || !profile.idleMotions?.length) return;
    const delay = IDLE_MOTION_MIN_MS + Math.random() * IDLE_MOTION_SPAN_MS;
    idleMotionTimers.set(petId, scope.timeout(() => {
      void (async () => {
        const current = deps.pets.get(petId);
        const list = (current?.idleMotions ?? []).filter((file) => motionFiles.includes(file));
        if (current && current.enabled !== false && list.length && !deps.isIdleMotionPaused()
          && Date.now() >= idleMotionBusyUntil) {
          idleMotionBusyUntil = Date.now() + IDLE_MOTION_LOCK_MS;
          const file = list[Math.floor(Math.random() * list.length)]!;
          try {
            // 第三參數 lowPower=true:待機播放以半幀率跑(手動/agent 觸發的播放不帶)
            deps.win?.webContents.send('vrma-play', petId, await readFile(join(deps.motionsDir(), file)), true);
          } catch { /* 檔案剛被移走:這輪跳過,下輪過濾自然排除 */ }
        }
        scheduleIdleMotion(petId); // 排下一輪(撞到互斥鎖的這輪不播,順延到下一個隨機間隔)
      })();
    }, delay));
  }

  function motionMenuItems(petId: string): Electron.MenuItemConstructorOptions[] {
    if (motionsDirMissing) return [{ label: t('tray.noMotionsDir'), enabled: false }];
    if (!motionFiles.length) return [{ label: t('tray.noMotionFiles'), enabled: false }];
    const dir = deps.motionsDir();
    return motionFiles.map((file) => ({
      label: file.replace(/\.vrma$/i, ''),
      click: async () => {
        try {
          deps.win?.webContents.send('vrma-play', petId, await readFile(join(dir, file)));
        } catch (error) {
          console.log('[main] vrma read failed', error);
        }
      }
    }));
  }

  /** 設定預設姿勢(選單與設定面板共用):即選即播 + 存檔 + 同步 UI。file=null 清除。 */
  async function setDefaultPose(petId: string, file: string | null): Promise<void> {
    if (file && !motionFiles.includes(file)) return; // 白名單:只接受 motions/ 裡的檔名
    if (!deps.updatePet(petId, { defaultPose: file ?? undefined })) return;
    deps.refreshTray();
    deps.sendPetProfiles(); // 設定面板的下拉跟著同步
    if (!file) return;
    try {
      deps.win?.webContents.send('vrma-play', petId, await readFile(join(deps.motionsDir(), file)));
    } catch (error) {
      console.log('[main] default pose read failed', error);
    }
  }

  function defaultPoseMenuItems(petId: string): Electron.MenuItemConstructorOptions[] {
    const current = deps.getPet(petId)?.defaultPose;
    const none: Electron.MenuItemConstructorOptions = {
      label: t('common.none'),
      type: 'radio',
      checked: !current,
      click: () => void setDefaultPose(petId, null)
    };
    if (motionsDirMissing) return [none];
    return [
      none,
      ...motionFiles.map((file): Electron.MenuItemConstructorOptions => ({
        label: file.replace(/\.vrma$/i, ''),
        type: 'radio',
        checked: file === current,
        click: () => void setDefaultPose(petId, file)
      }))
    ];
  }
  async function start() {
    if (!scope.start()) return;

    await refreshMotions();
    if (scope.disposed) return;

    for (const id of deps.pets.keys()) scheduleIdleMotion(id);
    // 開機排程各寵的待機動作
    try {
      // macOS 單次檔案變動常觸發多個 watch 事件:debounce 讓一批變動只做一次 readdir + Tray 重建
      let motionsDebounce: NodeJS.Timeout | null = null;
      motionsWatcher = watch(deps.motionsDir(), () => {
        if (motionsDebounce) scope.clearTimeout(motionsDebounce);
        motionsDebounce = scope.timeout(() => void refreshMotions().then(deps.refreshTray), 300);
      });
    } catch { /* 選單會顯示 motions 資料夾不存在 */ }
  }
  scope.add(() => {
    motionsWatcher?.close();
    motionsWatcher = null;
    idleMotionTimers.clear();
  });
  return {
    get scheduleIdleMotion() { return scheduleIdleMotion; },
    cancelIdleMotion,
    get motionMenuItems() { return motionMenuItems; },
    get defaultPoseMenuItems() { return defaultPoseMenuItems; },
    get motionFiles() { return motionFiles; },
    get motionsWatcher() { return motionsWatcher; },
    get refreshMotions() { return refreshMotions; },
    get setDefaultPose() { return setDefaultPose; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Motions = ReturnType<typeof createMotions>;
