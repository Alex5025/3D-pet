import * as THREE from 'three';
import { createViewer } from './viewer';

/**
 * 桌面疊層:透明背景 + 官方 viewer。
 * - 預設載入內建的 AvatarSample_A;主行程若送來使用者選的 VRM buffer 就替換。
 * - 拖任何 .vrm 檔到角色上也能替換(官方 dnd.html 同一條路)。
 * - hover 到角色 → 通知主行程把視窗切成可互動(否則整片 click-through)。
 */
const viewer = createViewer({ transparent: true });
viewer.loadFromUrl('/AvatarSample_A.vrm').catch((e) => console.log('[overlay] default load failed', e));

/* 使用者選的 VRM(Tray / dialog 那條路),主行程讀完檔用 buffer 送過來 */
window.pet.onVrm(async (buf) => {
  try {
    await viewer.loadFromBuffer(buf);
  } catch (e) {
    console.log('[overlay] vrm swap failed', e);
  }
});

/* 拖放替換(不需要檔案路徑,直接讀內容 → 官方 parse 路徑) */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f || !f.name.endsWith('.vrm')) return;
  try {
    await viewer.loadFromBuffer(await f.arrayBuffer());
  } catch (err) {
    console.log('[overlay] drop swap failed', err);
  }
});

/* ------------------------------------------------------------------ *
 * 命中 → 互動切換。
 * click-through 視窗在 macOS 收不到被動 mousemove(已實證),
 * 所以主行程輪詢游標座標推過來,這裡 raycast 判斷有沒有壓在角色上。
 * ------------------------------------------------------------------ */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let interactive = false;

function overPet(x: number, y: number): boolean {
  const vrm = viewer.currentVrm();
  if (!vrm) return false;
  ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
  raycaster.setFromCamera(ndc, viewer.camera);
  return raycaster.intersectObject(vrm.scene, true).length > 0;
}

function setInteractive(v: boolean): void {
  if (v === interactive) return;
  interactive = v;
  window.pet.setInteractive(v);
}

window.pet.onCursor(({ x, y }) => setInteractive(overPet(x, y)));
addEventListener('mousemove', (e) => setInteractive(overPet(e.clientX, e.clientY)));
