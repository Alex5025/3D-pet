import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';
import { t } from '../shared/i18n';
import { groupPetsByWorkspace } from '../shared/petGroups';
import { createResourceScope } from './resourceScope';
import type { AppRegistry, PetProfile } from './runtimeTypes';

export interface TrayDeps {
  readonly registry: AppRegistry;
  readonly housePet: () => string | null;
  readonly toggleHouse: (id: string) => void;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly pets: Map<string, PetProfile>;
  readonly selectPet: (id: string) => PetProfile | null;
  readonly chooseVrm: (petId: string, parent?: BrowserWindow | undefined) => Promise<void>;
  readonly motionMenuItems: (petId: string) => Electron.MenuItemConstructorOptions[];
  readonly defaultPoseMenuItems: (petId: string) => Electron.MenuItemConstructorOptions[];
  readonly win: BrowserWindow | null;
  readonly openSettings: (tab?: "light" | "char" | "motion" | "project", petId?: string | undefined) => void;
  readonly openControlPanel: (tab?: "overview" | "sandbox") => void;
  readonly resetState: (petId: string) => void;
  readonly restartPet: (petId: string) => Promise<void>;
  readonly setPetEnabled: (id: string, enabled: boolean) => Promise<PetProfile | null>;
  readonly serializeCharacter: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly createNewPet: () => Promise<PetProfile>;
  readonly restartApp: () => void;
  readonly shutdownSync: () => void;
}

/** tray 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createTray(deps: TrayDeps) {
  const scope = createResourceScope();

  const TRAY_ICON =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZklEQVR4nGNgoAFQAOIEIJ4PxPeheD5UTAGfRpiG/wQwzEAMQIxmZEMwnE2sZhhG8U4CGQYkoPufVANQwoEU/2MNB4oNoNgLFAeiAhkGKDCgAYoSEiwciDHkPrr/0YECA5mZiSwAANJTnOH5R44LAAAAAElFTkSuQmCC';

  let tray: Tray | null = null;

  function refreshTray(): void {
    if (deps.registry) tray?.setContextMenu(petMenu(deps.registry.selectedPetId));
  }

  function petMenu(requestedId?: string): Menu {
    const profile = deps.getPet(requestedId) ?? [...deps.pets.values()][0];
    const petId = profile.id;
    return Menu.buildFromTemplate([
      { label: t('tray.currentPet', { name: profile.name }), enabled: false },
      {
        label: t('tray.switchPet'),
        submenu: groupPetsByWorkspace([...deps.pets.values()]).map((group) => ({
          label: `📁 ${group.name}`,
          submenu: group.pets.map((item) => ({
            // 休息中的寵物仍列出(讓使用者知道存在),但灰掉不可選。
            label: `${item.enabled ? '' : t('common.restingPrefix')}${item.name}`,
            type: 'radio' as const,
            checked: item.id === petId,
            enabled: item.enabled,
            click: () => deps.selectPet(item.id)
          }))
        }))
      },
      { type: 'separator' },
      ...(process.platform === 'darwin' ? [{
        label: deps.housePet() ? t('tray.houseRecall') : t('tray.houseRead'),
        enabled: profile.enabled || !!deps.housePet(),
        click: () => deps.toggleHouse(petId),
      }] : []),
      { label: t('tray.chooseVrm'), click: () => void deps.chooseVrm(petId) },
      {
        label: t('tray.motions'),
        submenu: [
          { label: t('tray.playMotion'), submenu: deps.motionMenuItems(petId) },
          { label: t('tray.defaultPose'), submenu: deps.defaultPoseMenuItems(petId) },
          { type: 'separator' },
          { label: t('tray.stopMotion'), click: () => deps.win?.webContents.send('vrma-stop', petId) }
        ]
      },
      {
        // 一般外觀與工作設定共用分頁；高風險沙盒設定刻意排除。
        label: t('tray.settings'),
        submenu: [
          { label: t('tray.settingsProject'), click: () => deps.openSettings('project', petId) },
          { label: t('tray.settingsLight'), click: () => deps.openSettings('light', petId) },
          { label: t('tray.settingsChar'), click: () => deps.openSettings('char', petId) },
          { label: t('tray.settingsMotion'), click: () => deps.openSettings('motion', petId) }
        ]
      },
      { label: t('tray.controlPanel'), click: () => deps.openControlPanel() },
      { label: t('tray.sandboxSettings'), click: () => deps.openControlPanel('sandbox') },
      { label: t('tray.resetState'), click: () => deps.resetState(petId) },
      {
        label: t('tray.restartPet'),
        enabled: profile.enabled,
        click: () => void deps.restartPet(petId)
      },
      {
        label: profile.enabled ? t('tray.restCurrent') : t('tray.wakeCurrent'),
        click: () => deps.setPetEnabled(petId, !profile.enabled)
      },
      { type: 'separator' },
      {
        label: t('tray.addPet'),
        click: async () => {
          const created = await deps.serializeCharacter(deps.createNewPet);
          deps.openSettings('project', created.id);
        }
      },
      { label: t('tray.restartSystem'), click: deps.restartApp },
      // app.exit 不觸發 before-quit,清理要在這裡自己做(已知坑,見 DEVLOG §22)
      { label: t('tray.quit'), click: () => { deps.shutdownSync(); app.exit(0); } }
    ]);
  }
  function start() {
    if (!scope.start()) return;

    const icon = nativeImage.createFromDataURL(TRAY_ICON);

    icon.setTemplateImage(true);

    tray = new Tray(icon);

    tray.setToolTip(t('tray.tooltip'));

    tray.setContextMenu(petMenu(deps.registry.selectedPetId));
  }
  scope.add(() => { tray?.destroy(); tray = null; });
  return {
    get refreshTray() { return refreshTray; },
    get tray() { return tray; },
    get petMenu() { return petMenu; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type TrayService = ReturnType<typeof createTray>;
