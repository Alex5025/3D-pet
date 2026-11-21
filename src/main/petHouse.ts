import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PetProfile } from './runtimeTypes';

interface HouseDeps {
  readonly overlay: BrowserWindow | null;
  readonly getPet: (id: string) => PetProfile | null;
  readonly defaultVrmPath: () => string;
  readonly refresh: () => void;
}

/** macOS 桌面層小屋；只由原生選單指定角色，不接受 renderer 傳入任意檔案路徑。 */
export function createPetHouse(deps: HouseDeps) {
  let house: BrowserWindow | null = null;
  let petId: string | null = null;
  let request = 0;
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function locate(): void {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const w = Math.min(330, width);
    const h = Math.min(305, height);
    house?.setBounds({ x: x + Math.max(0, width - w - 18), y: y + Math.max(0, height - h - 14), width: w, height: h });
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function recall(update = true): void {
    clearTimer();
    waiting = false;
    const active = house;
    const oldId = petId;
    house = null;
    petId = null;
    if (active && !active.isDestroyed()) active.destroy();
    if (oldId && deps.overlay && !deps.overlay.isDestroyed()) {
      deps.overlay.webContents.send('pet-house-presence', null, ++request);
    }
    if (update) deps.refresh();
  }

  async function model(event: { sender: Electron.WebContents }): Promise<ArrayBuffer | null> {
    const pet = petId && house?.webContents === event.sender ? deps.getPet(petId) : null;
    if (!pet?.enabled) return null;
    try {
      const data = await readFile(pet.vrmPath ?? deps.defaultVrmPath());
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch {
      // 不以其他角色代替；讀取失敗則保留原桌寵。
      return null;
    }
  }

  function sceneReady(event: IpcMainEvent, ready: boolean): void {
    if (!house || event.sender !== house.webContents || !petId) return;
    if (ready !== true || !deps.overlay || !deps.getPet(petId)?.enabled) {
      recall();
      return;
    }
    waiting = true;
    deps.overlay.webContents.send('pet-house-presence', petId, ++request);
  }

  function overlayApplied(event: IpcMainEvent, token: number, ready: boolean): void {
    if (!house || !waiting || token !== request || event.sender !== deps.overlay?.webContents) return;
    waiting = false;
    if (ready !== true) {
      recall();
      return;
    }
    clearTimer();
    house.showInactive();
  }

  const repair = () => { if (petId) recall(); };

  function toggle(id: string): void {
    if (process.platform !== 'darwin') return;
    if (house) { recall(); return; }
    if (!deps.getPet(id)?.enabled || !deps.overlay) return;
    petId = id;
    const window = new BrowserWindow({
      title: 'VRM Pet House', type: 'desktop', show: false, width: 330, height: 305,
      transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
      focusable: false, fullscreenable: false, skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    house = window;
    window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => { if (house === window) recall(); });
    window.on('closed', () => { if (house === window) recall(); });
    locate();
    timer = setTimeout(() => { if (house === window) recall(); }, 10000);
    const dev = process.env['ELECTRON_RENDERER_URL'];
    const page = dev ? window.loadURL(`${dev}/petHouse.html`) : window.loadFile(join(__dirname, '../renderer/petHouse.html'));
    void page.catch(() => { if (house === window) recall(); });
    deps.refresh();
  }

  function start(): void {
    if (process.platform !== 'darwin') return;
    ipcMain.handle('get-pet-house-model', model);
    ipcMain.on('pet-house-scene-ready', sceneReady);
    ipcMain.on('pet-house-presence-applied', overlayApplied);
    screen.on('display-metrics-changed', locate);
    deps.overlay?.webContents.on('did-finish-load', repair);
  }

  function dispose(): void {
    if (process.platform !== 'darwin') return;
    recall(false);
    ipcMain.removeHandler('get-pet-house-model');
    ipcMain.removeListener('pet-house-scene-ready', sceneReady);
    ipcMain.removeListener('pet-house-presence-applied', overlayApplied);
    screen.removeListener('display-metrics-changed', locate);
    deps.overlay?.webContents.removeListener('did-finish-load', repair);
  }

  return { start, dispose, toggle, get petId() { return petId; } };
}
