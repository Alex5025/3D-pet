import { BrowserWindow, ipcMain, screen } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PetProfile } from './runtimeTypes';

interface HouseDeps {
  readonly pets: Map<string, PetProfile>;
  appearance(id: string): { path: string; wardrobe: Record<string, boolean> } | null;
  defaultVrmPath(): string;
}

export function createPetHouse(deps: HouseDeps) {
  let house: BrowserWindow | null = null;
  let previous = '';
  function locate(): void {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const w = Math.min(460, width), h = Math.min(360, height);
    house?.setBounds({ x: x + Math.max(0, width - w - 12), y: y + Math.max(0, height - h - 8), width: w, height: h });
  }
  function sync(): void {
    if (!house) return;
    const ids = [...deps.pets.values()].filter(p => !p.enabled).map(p => p.id);
    const signature = JSON.stringify(ids);
    if (previous === signature) return;
    previous = signature;
    house.webContents.send('pet-house-roster', ids);
  }
  function start(): void {
    if (process.platform !== 'darwin') return;
    ipcMain.handle('get-pet-house-model', async (event, id: string) => {
      const pet = deps.pets.get(id);
      if (event.sender !== house?.webContents || !pet || pet.enabled) return null;
      const saved = deps.appearance(id);
      if (!saved && pet.characterId) return null;
      const bytes = await readFile(saved?.path ?? pet.vrmPath ?? deps.defaultVrmPath());
      return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), wardrobe: saved?.wardrobe ?? pet.wardrobe ?? {} };
    });
    house = new BrowserWindow({
      title: 'VRM Pet House', type: 'desktop', show: false, transparent: true, frame: false,
      hasShadow: false, resizable: false, movable: false, focusable: false, fullscreenable: false, skipTaskbar: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false },
    });
    house.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    house.setIgnoreMouseEvents(true);
    house.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    house.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.on('pet-house-roster-ready', rosterReady);
    house.once('ready-to-show', () => house?.showInactive());
    locate();
    screen.on('display-metrics-changed', locate);
    const dev = process.env['ELECTRON_RENDERER_URL'];
    const loading = dev ? house.loadURL(`${dev}/petHouse.html`) : house.loadFile(join(__dirname, '../renderer/petHouse.html'));
    void loading.catch(error => console.error('[pet-house]', error));
  }
  function rosterReady(event: Electron.IpcMainEvent): void {
    if (event.sender !== house?.webContents) return;
    previous = '';
    sync();
  }
  function dispose(): void {
    if (process.platform !== 'darwin') return;
    screen.removeListener('display-metrics-changed', locate);
    ipcMain.removeHandler('get-pet-house-model');
    ipcMain.removeListener('pet-house-roster-ready', rosterReady);
    house?.destroy();
    house = null;
  }
  return { start, dispose, sync };
}
