import { BrowserWindow, Tray, app, dialog } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { parseCharacterExport, type CharacterFileResult } from '../../shared/character';
import { LOCALES, getLocale, resolveLocale, setLocale, t, type Locale } from '../../shared/i18n';
import type { ProjectSandboxSettingsInput, ProjectSandboxSettingsResult } from '../../shared/sandboxSettings';
import type { AgentBridge } from '../agent/bridge';
import { appPrompt } from '../appPrompt';
import { CharacterStore, applyCharacter, atomicYaml, parseCharacterYaml } from '../characterStore';
import { createResourceScope } from '../resourceScope';
import type { AppRegistry, PetProfile } from '../runtimeTypes';
import { readProjectSandboxSettings, writeProjectSandboxSettings } from '../sandboxConfig';

export interface IpcSettingsDeps {
  readonly win: BrowserWindow | null;
  readonly settingsWin: BrowserWindow | null;
  readonly controlWin: BrowserWindow | null;
  readonly refreshTray: () => void;
  readonly tray: Tray | null;
  readonly persistConfigSync: () => void;
  readonly storageError: string;
  readonly pets: Map<string, PetProfile>;
  readonly serializeCharacter: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly characters: CharacterStore;
  readonly reportStorageError: (error: unknown) => void;
  readonly scheduleIdleMotion: (petId: string) => void;
  readonly sendPetProfiles: () => void;
  readonly chooseVrm: (petId: string, parent?: BrowserWindow | undefined) => Promise<void>;
  readonly selectProject: (profile: PetProfile, path: string) => boolean;
  readonly chooseWorkspace: (petId: string, parent?: BrowserWindow | undefined) => Promise<string | null>;
  readonly workspaceRoot: () => string;
  readonly registry: AppRegistry;
  readonly scheduleConfigFlush: () => void;
  readonly bridge: AgentBridge | null;
  readonly refreshMotions: () => Promise<void>;
  readonly motionFiles: string[];
  readonly setDefaultPose: (petId: string, file: string | null) => Promise<void>;
}

/** ipc/settings 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcSettings(deps: IpcSettingsDeps) {
  const scope = createResourceScope();

  /** 集中套用:main 自己換語言 → 廣播三視窗 → Tray/標題/tooltip 重建 → 清模型清單快取(label 含翻譯)。 */
  function applyLocaleEverywhere(locale: Locale): void {
    setLocale(locale);
    deps.win?.webContents.send('locale-apply', locale);
    deps.settingsWin?.webContents.send('locale-apply', locale);
    deps.controlWin?.webContents.send('locale-apply', locale);
    deps.refreshTray();
    deps.tray?.setToolTip(t('tray.tooltip'));
    deps.settingsWin?.setTitle(t('window.settings'));
    deps.controlWin?.setTitle(t('window.control'));
    modelListCache.clear(); // claude 模型 label 含翻譯,舊語言快取要作廢
  }

  // 模型清單:codex 要跟 app-server 要(首次會 lazy 啟動),成功才快取(失敗可能只是還沒登入,下次再試)
  // 快取 10 分鐘 TTL:CLI 升版新增模型不用重啟 app 才看得到
  const modelListCache = new Map<string, { at: number; list: unknown[]; }>();
  async function start() {
    if (!scope.start()) return;

    // 設定分頁與桌寵右鍵選單共用選檔流程;僅允許這兩個視窗操作既有寵物。
    scope.ipc.handle('character-storage-retry', (event) => {
      if (event.sender !== deps.settingsWin?.webContents) return '';
      deps.persistConfigSync();
      return deps.storageError;
    });

    scope.ipc.handle('character-storage-status', (event) => event.sender === deps.settingsWin?.webContents ? deps.storageError : '');

    scope.ipc.handle('character-file', async (event, id: string, action: unknown): Promise<CharacterFileResult> => {
      if (!deps.settingsWin || event.sender !== deps.settingsWin.webContents || !deps.pets.has(id)
        || (action !== 'import' && action !== 'export')) return { ok: false, message: '無法操作角色設定' };
      return deps.serializeCharacter(async () => {
        try {
          const profile = deps.getPet(id);
          if (!profile?.enabled || !profile.characterReady || !profile.characterId || profile.characterError) throw new Error(profile?.characterError ?? '請先喚醒寵物再匯入或匯出');
          const characterId = profile.characterId;
          const document = deps.characters.get(characterId);
          if (!document) throw new Error('尚未載入角色設定');
          const parent = deps.settingsWin!;
          if (action === 'export') {
            const result = await dialog.showSaveDialog(parent, { title: '匯出角色設定', defaultPath: 'character.yaml', filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }] });
            if (result.canceled || !result.filePath) return { ok: false, canceled: true };
            if (deps.getPet(id)?.characterId !== characterId) throw new Error('角色已變更，請重新操作');
            deps.characters.flush();
            atomicYaml(result.filePath, { schemaVersion: 1, modelHash: document.modelHash, parameters: document.parameters });
          } else {
            const result = await dialog.showOpenDialog(parent, { title: '匯入角色設定', properties: ['openFile'], filters: [{ name: '角色設定', extensions: ['yaml', 'yml', 'json'] }] });
            const path = result.filePaths[0];
            if (result.canceled || !path) return { ok: false, canceled: true };
            if ((await stat(path)).size > 2_000_000) throw new Error('角色設定檔過大');
            const imported = parseCharacterExport(parseCharacterYaml(await readFile(path, 'utf8')));
            if (imported.modelHash !== document.modelHash) throw new Error('設定檔的 VRM 與目前模型不符');
            const answer = await appPrompt({ message: `以匯入設定覆寫「${profile.name}」的光影與角色參數？`, buttons: ['取消', '覆寫'], cancelId: 0 });
            if (answer.response !== 1) return { ok: false, canceled: true };
            if (deps.getPet(id)?.characterId !== characterId) throw new Error('角色已變更，請重新操作');
            const previous = structuredClone(document.parameters);
            deps.characters.update(characterId, imported.parameters);
            try { deps.characters.flush(); }
            catch (error) {
              deps.characters.update(characterId, previous);
              deps.reportStorageError(error);
              throw error;
            }
            applyCharacter(profile, imported.parameters);
            profile.characterRevision = (profile.characterRevision ?? 0) + 1;
            deps.scheduleIdleMotion(id);
            deps.persistConfigSync();
            deps.sendPetProfiles();
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      });
    });

    scope.ipc.handle('choose-vrm', async (event, id: string) => {
      const fromSettings = !!deps.settingsWin && event.sender === deps.settingsWin.webContents;
      const fromOverlay = !!deps.win && event.sender === deps.win.webContents;
      if ((!fromSettings && !fromOverlay) || !deps.pets.has(id)) return;
      // 透明桌面疊層不掛 sheet,沿用 Tray 的獨立對話框;設定視窗則維持 sheet。
      await deps.chooseVrm(id, fromSettings ? deps.settingsWin ?? undefined : undefined);
    });

    scope.ipc.handle('select-project', (event, id: string, path: string) => {
      if (![deps.win?.webContents, deps.settingsWin?.webContents, deps.controlWin?.webContents].includes(event.sender)) return false;
      const profile = deps.getPet(id);
      return profile && typeof path === 'string' ? deps.selectProject(profile, path) : false;
    });

    scope.ipc.handle('choose-workspace', (event, id: string) => {
      const parent = event.sender === deps.settingsWin?.webContents
        ? deps.settingsWin
        : event.sender === deps.controlWin?.webContents ? deps.controlWin : undefined;
      if (!parent || !deps.pets.has(id)) return null;
      return deps.chooseWorkspace(id, parent);
    });

    /* ── 全域:新寵物預設工作根目錄 ── */
    scope.ipc.handle('workspace-root-get', () => deps.workspaceRoot());

    scope.ipc.handle('choose-workspace-root', async (event): Promise<string> => {
      // 僅中控面板可變更(全域設定歸中控,循語言下拉的 sender 驗證慣例)
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) return deps.workspaceRoot();
      app.focus({ steal: true }); // 背景 app 的 dialog 會被壓在其他視窗底下
      deps.controlWin.focus();
      const result = await dialog.showOpenDialog(deps.controlWin, {
        title: t('dialog.chooseWorkspaceRoot'),
        buttonLabel: t('common.select'),
        defaultPath: deps.workspaceRoot(),
        properties: ['openDirectory', 'createDirectory']
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return deps.workspaceRoot();
      deps.registry.defaultWorkspaceRoot = path;
      deps.scheduleConfigFlush();
      deps.controlWin?.webContents.send('workspace-root-apply', path);
      return path;
    });

    /* ── 全域:介面語言(i18n)── */
    scope.ipc.handle('locale-get', () => getLocale());
    // 各視窗開機都要,不限 sender
    scope.ipc.handle('locale-pref-get', (event) => {
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) return '';
      return deps.registry.locale ?? ''; // '' = 跟隨系統(下拉初始選中用)
    });

    scope.ipc.handle('locale-set', (event, value: string): Locale => {
      // 語言下拉在中控面板(循 workspace-root 的單一具名視窗慣例)
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) return getLocale();
      if (value === '') delete deps.registry.locale; // 跟隨系統
      else if (LOCALES.includes(value as Locale)) deps.registry.locale = value;
      else return getLocale();
      deps.scheduleConfigFlush();
      applyLocaleEverywhere(deps.registry.locale ? (deps.registry.locale as Locale) : resolveLocale(app.getLocale()));
      return getLocale();
    });

    /* ── 專案 Codex 沙盒設定──
     * 設定視窗明確按下後由 main 直接讀寫 <workspace>/.codex/config.toml；不啟動 agent、不跑 shell。 */
    scope.ipc.handle('sandbox-settings-get', async (event, id: string): Promise<ProjectSandboxSettingsResult> => {
      // 高風險通道只開放中控面板的「沙盒設定」分頁這一個具名視窗
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) {
        return { ok: false, message: t('sandbox.onlyControl') };
      }
      const profile = deps.getPet(id);
      if (!profile?.workspacePath) return { ok: false, message: t('sandbox.needWorkspace') };
      try {
        return {
          ok: true,
          message: t('sandbox.readOk'),
          settings: await readProjectSandboxSettings(profile.workspacePath),
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    });

    scope.ipc.handle(
      'sandbox-settings-set',
      async (event, id: string, settings: ProjectSandboxSettingsInput): Promise<ProjectSandboxSettingsResult> => {
        if (!deps.controlWin || event.sender !== deps.controlWin.webContents) {
          return { ok: false, message: t('sandbox.onlyControl') };
        }
        const profile = deps.getPet(id);
        if (!profile?.workspacePath) return { ok: false, message: t('sandbox.needWorkspace') };
        try {
          return {
            ok: true,
            message: t('sandbox.writeOk'),
            settings: await writeProjectSandboxSettings(profile.workspacePath, settings),
          };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
    );

    scope.ipc.handle('agent-models', async (_event, kind: string) => {
      if (kind !== 'codex' && kind !== 'claude' && kind !== 'agy') return [];
      const cached = modelListCache.get(kind);
      if (cached && Date.now() - cached.at < 600_000) return cached.list;
      const list = (await deps.bridge?.listModels(kind)) ?? [];
      if (list.length) modelListCache.set(kind, { at: Date.now(), list });
      else if (cached) return cached.list; // 拉失敗時寧可用過期清單也不回空
      return list;
    });

    scope.ipc.handle('motion-list', async () => {
      await deps.refreshMotions(); // 面板打開時可能剛放了新檔,跟 popup 前刷新同一個保險
      return deps.motionFiles;
    });

    scope.ipc.on('set-default-pose', (_event, petId: string, file: string | null) => {
      if (!deps.pets.has(petId)) return;
      void deps.setDefaultPose(petId, typeof file === 'string' ? file : null);
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcSettings = ReturnType<typeof createIpcSettings>;
