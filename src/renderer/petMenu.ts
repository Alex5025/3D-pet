import './petMenu.css';
import { t } from '../shared/i18n';
import { groupPetsByWorkspace, workspaceFolderName } from '../shared/petGroups';
import type { PetProfile } from '../preload/index';

/* 寵物右鍵選單(自繪 DOM):原生 Menu 無法套用設計語言。
 * 結構為精簡兩層:主選單只留天天用的(播放動作/設定/中控/休息),其餘收進「更多」子頁;
 * 子選單不用飛出面板(疊層上易超出邊界),改為就地換頁 + 返回列。
 * 動作經 preload 的 menu-* IPC 回 main,走與 Tray 選單相同的函式。 */

let root: HTMLDivElement | null = null;
let closeListener: ((event: MouseEvent) => void) | null = null;

export function isPetMenuOpen(): boolean {
  return root !== null;
}

export function closePetMenu(): void {
  if (!root) return;
  root.remove();
  root = null;
  if (closeListener) {
    document.removeEventListener('mousedown', closeListener, true);
    closeListener = null;
  }
}

interface MenuEntry {
  label: string;
  /** 'sep' 分隔線;'group' 子頁群組標(不可點)。 */
  kind?: 'sep' | 'group';
  /** 前置 emoji 圖示(語言中立,不進 i18n);固定寬插槽對齊。 */
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** radio 頁的勾號(占位對齊:undefined = 此頁無 radio,不占位)。 */
  checked?: boolean;
  /** 有子頁 → 顯示 ▸,點擊換頁。 */
  submenu?: () => void;
  action?: () => void;
}

const SEP: MenuEntry = { label: '', kind: 'sep' };

export interface PetMenuOptions {
  /** 標頭大頭照(data URL);缺省時退回狀態點。 */
  avatar?: string;
}

function clampToViewport(anchorX: number, anchorY: number): void {
  if (!root) return;
  const rect = root.getBoundingClientRect();
  const left = Math.min(anchorX, innerWidth - rect.width - 8);
  const top = Math.min(anchorY, innerHeight - rect.height - 8);
  root.style.left = `${Math.max(8, left)}px`;
  root.style.top = `${Math.max(8, top)}px`;
}

export async function showPetMenu(x: number, y: number, petId: string, options: PetMenuOptions = {}): Promise<void> {
  closePetMenu();
  // 右鍵即選中(與原生 show-menu 行為一致),同時抓資料快照
  const [collection, motions] = await Promise.all([
    window.pet.getPetCollection(),
    window.pet.getMotionList(),
  ]);
  void window.pet.selectPet(petId);
  const profile = collection.pets.find((item) => item.id === petId);
  if (!profile) return;

  root = document.createElement('div');
  root.className = 'pet-menu';
  document.body.append(root);

  const done = closePetMenu;

  const renderPage = (entries: MenuEntry[], backTo?: () => void): void => {
    if (!root) return;
    root.replaceChildren();
    if (backTo) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'menu-back';
      back.textContent = t('menu.back');
      back.addEventListener('click', backTo);
      root.append(back);
    } else {
      const head = document.createElement('div');
      head.className = 'menu-head';
      if (options.avatar) {
        const avatar = document.createElement('img');
        avatar.className = 'menu-avatar';
        avatar.alt = '';
        avatar.src = options.avatar;
        head.append(avatar);
      } else {
        const dot = document.createElement('span');
        dot.className = `menu-dot${profile.enabled ? '' : ' resting'}`;
        head.append(dot);
      }
      const meta = document.createElement('div');
      meta.className = 'menu-meta';
      const name = document.createElement('div');
      name.className = 'menu-name';
      name.textContent = profile.name;
      meta.append(name);
      const folder = workspaceFolderName(profile.workspacePath);
      if (folder) {
        const workspace = document.createElement('div');
        workspace.className = 'menu-workspace';
        workspace.textContent = `📁 ${folder}`;
        workspace.title = profile.workspacePath ?? '';
        meta.append(workspace);
      }
      head.append(meta);
      root.append(head, document.createElement('hr'));
    }
    const list = document.createElement('div');
    list.className = 'menu-list';
    for (const entry of entries) {
      if (entry.kind === 'sep') {
        list.append(document.createElement('hr'));
        continue;
      }
      if (entry.kind === 'group') {
        const group = document.createElement('div');
        group.className = 'menu-group';
        group.textContent = entry.label;
        list.append(group);
        continue;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `menu-item${entry.danger ? ' danger' : ''}`;
      item.disabled = entry.disabled === true;
      if (entry.checked !== undefined) {
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = entry.checked ? '✓' : '';
        item.append(mark);
      }
      if (entry.icon !== undefined) {
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = entry.icon;
        item.append(icon);
      }
      const label = document.createElement('span');
      label.className = 'grow';
      label.textContent = entry.label;
      item.append(label);
      if (entry.submenu) {
        const chev = document.createElement('span');
        chev.className = 'chev';
        chev.textContent = '▸';
        item.append(chev);
      }
      item.addEventListener('click', () => {
        if (entry.submenu) entry.submenu();
        else if (entry.action) {
          done();
          entry.action();
        }
      });
      list.append(item);
    }
    root.append(list);
    clampToViewport(x, y);
  };

  /* ── 主選單:天天用的四項 + 更多 ── */
  const mainPage = (): void => {
    renderPage([
      {
        icon: '🎬',
        label: t('tray.playMotion'),
        disabled: !motions.length,
        submenu: motions.length ? motionsPage : undefined,
      },
      { icon: '⚙️', label: t('tray.settings'), action: () => window.pet.openSettings('light', petId) },
      { icon: '🎛️', label: t('tray.controlPanel'), action: () => window.pet.openControlPanel() },
      {
        icon: profile.enabled ? '😴' : '⏰',
        label: profile.enabled ? t('tray.restCurrent') : t('tray.wakeCurrent'),
        action: () => void window.pet.updatePetMeta(petId, { enabled: !profile.enabled }),
      },
      SEP,
      { icon: '⋯', label: t('menu.more'), submenu: morePage },
    ]);
  };

  /* ── 更多:偶爾用的與危險動作(危險留底部) ── */
  const morePage = (): void => {
    const entries: MenuEntry[] = [
      { icon: '🧍', label: t('tray.defaultPose'), submenu: posePage },
      { icon: '📦', label: t('tray.chooseVrm'), action: () => void window.pet.chooseVrmFile(petId) },
    ];
    if (collection.pets.length > 1) {
      entries.push({ icon: '🔁', label: t('tray.switchPet'), submenu: petsPage });
    }
    entries.push(
      { icon: '📐', label: t('tray.resetState'), action: () => window.pet.resetPetState(petId) },
      { icon: '♻️', label: t('tray.restartPet'), disabled: !profile.enabled, action: () => window.pet.restartPet(petId) },
      { icon: '🛡️', label: t('tray.sandboxSettings'), action: () => window.pet.openControlPanel('sandbox') },
      SEP,
      {
        icon: '➕',
        label: t('tray.addPet'),
        action: async () => {
          const created = await window.pet.createPet();
          window.pet.openSettings('project', created.id);
        },
      },
      { icon: '🔄', label: t('tray.restartSystem'), action: () => window.pet.systemRestart() },
      { icon: '⏻', label: t('tray.quit'), danger: true, action: () => window.pet.systemQuit() },
    );
    renderPage(entries, mainPage);
  };

  const petsPage = (): void => {
    const entries: MenuEntry[] = [];
    for (const group of groupPetsByWorkspace(collection.pets)) {
      entries.push({ label: `📁 ${group.name}`, kind: 'group' });
      for (const item of group.pets) {
        entries.push({
          // 休息中的寵物仍列出(讓使用者知道存在),但灰掉不可選(與原生選單一致)
          label: `${item.enabled ? '' : t('common.restingPrefix')}${item.name}`,
          checked: item.id === petId,
          disabled: !item.enabled,
          action: () => void window.pet.selectPet(item.id),
        });
      }
    }
    renderPage(entries, morePage);
  };

  const motionsPage = (): void => {
    renderPage(
      [
        { icon: '⏹', label: t('tray.stopMotion'), action: () => window.pet.stopMotion(petId) },
        SEP,
        ...motions.map((file) => ({
          label: file.replace(/\.vrma$/i, ''),
          action: () => window.pet.playMotion(petId, file),
        })),
      ],
      mainPage,
    );
  };

  const posePage = (): void => {
    const current = profile.defaultPose ?? '';
    renderPage(
      [
        { label: t('common.none'), checked: !current, action: () => window.pet.setDefaultPose(petId, null) },
        ...motions.map((file) => ({
          label: file.replace(/\.vrma$/i, ''),
          checked: file === current,
          action: () => window.pet.setDefaultPose(petId, file),
        })),
      ],
      morePage,
    );
  };

  mainPage();

  // 點選單外任意處收合(捕獲階段,免得被其他 handler 吃掉)
  closeListener = (event: MouseEvent) => {
    if (root && !root.contains(event.target as Node)) closePetMenu();
  };
  document.addEventListener('mousedown', closeListener, true);
}
