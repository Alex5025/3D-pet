import { DEFAULT_LIGHTING, DEFAULT_SWAY, type Lighting, type Sway } from './viewer';
import type { AgentKind, AgentModelInfo, PetProfile, PetState, WardrobeItem } from '../preload/index';
import { groupPetsByWorkspace } from '../shared/petGroups';

const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };
const el = (id: string): HTMLElement => document.getElementById(id)!;
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;

let profiles: PetProfile[] = [];
let selectedPetId = '';
let lighting: Lighting = { ...DEFAULT_LIGHTING };
let sway: Sway = { ...DEFAULT_SWAY };
let petState: PetState = { ...DEFAULT_STATE };
let wardrobeStates: Record<string, boolean> = {};

function selectedProfile(): PetProfile | null {
  return profiles.find((profile) => profile.id === selectedPetId) ?? null;
}

/* ---------- 分頁 ---------- */
function activateTab(name: string): void {
  if (!document.getElementById(`tab-${name}`)) return;
  document.querySelectorAll('#tabs button').forEach((button) => {
    button.classList.toggle('active', (button as HTMLButtonElement).dataset['tab'] === name);
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  el(`tab-${name}`).classList.add('active');
  el('reset').hidden = name === 'project' || name === 'motion'; // 重置只作用於光影/角色參數
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  button.addEventListener('click', () => activateTab(button.dataset['tab']!));
}
const initialTab = new URLSearchParams(location.search).get('tab') ?? 'light';
window.pet.onSwitchTab(activateTab);

/* ---------- 寵物選擇與工作設定 ---------- */
function renderPetSelector(): void {
  const select = el('pet-select') as HTMLSelectElement;
  select.innerHTML = '';
  for (const group of groupPetsByWorkspace(profiles)) {
    const options = document.createElement('optgroup');
    options.label = `📁 ${group.name}`;
    for (const profile of group.pets) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `${profile.enabled ? '' : '（休息中）'}${profile.name}`;
      options.appendChild(option);
    }
    select.appendChild(options);
  }
  select.value = selectedPetId;
  (el('remove-pet') as HTMLButtonElement).disabled = profiles.length <= 1;
}

/* 角色設定(個性):自由文字,注入 agent 對話的 system prompt(claude 逐 turn;codex 注入既有 thread)。
 * 輸入即存(debounce)+ 失焦/切視窗立即補存——設定面板是獨立視窗,改完直接點回桌寵
 * 不會觸發頁面內 blur,原本只掛 change 事件會漏存。 */
const personaEl = el('pet-persona') as HTMLTextAreaElement;
let personaTimer: number | null = null;
async function savePersona(): Promise<void> {
  if (personaTimer !== null) {
    clearTimeout(personaTimer);
    personaTimer = null;
  }
  const profile = selectedProfile();
  if (!profile || (profile.persona ?? '') === personaEl.value) return;
  await window.pet.updatePetMeta(profile.id, { persona: personaEl.value });
}
personaEl.addEventListener('input', () => {
  if (personaTimer !== null) clearTimeout(personaTimer);
  personaTimer = window.setTimeout(() => void savePersona(), 500);
});
personaEl.addEventListener('blur', () => void savePersona());
window.addEventListener('blur', () => void savePersona());

/** 預設姿勢下拉(角色分頁):清單來自 motions/,即選即播(與右鍵選單同一條 main 端邏輯)。 */
let motionList: string[] | null = null;

async function renderDefaultPose(): Promise<void> {
  const select = el('default-pose') as HTMLSelectElement;
  motionList ??= await window.pet.getMotionList();
  const current = selectedProfile()?.defaultPose ?? '';
  select.innerHTML = '';
  select.append(new Option('（無）', ''));
  for (const file of motionList) select.append(new Option(file.replace(/\.vrma$/i, ''), file));
  if (current && !motionList.includes(current)) select.append(new Option(`${current}（檔案不存在）`, current));
  select.value = current;
}

/** 待機動作勾選清單(角色分頁):勾選的動作由 main 以隨機間隔播放;逐寵儲存。 */
async function renderIdleMotions(): Promise<void> {
  const box = el('idle-motions');
  motionList ??= await window.pet.getMotionList();
  const selected = new Set(selectedProfile()?.idleMotions ?? []);
  box.innerHTML = '';
  if (!motionList.length) {
    box.innerHTML = '<span class="empty">motions/ 資料夾沒有動作檔</span>';
    return;
  }
  for (const file of motionList) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(file);
    checkbox.addEventListener('change', () => {
      const profile = selectedProfile();
      if (!profile) return;
      const current = new Set(profile.idleMotions ?? []);
      if (checkbox.checked) current.add(file);
      else current.delete(file);
      profile.idleMotions = [...current]; // 本地同步,連續勾選不被廣播回寫蓋掉
      void window.pet.updatePetMeta(profile.id, { idleMotions: profile.idleMotions });
    });
    label.append(checkbox, document.createTextNode(file.replace(/\.vrma$/i, '')));
    box.append(label);
  }
}

el('default-pose').addEventListener('change', () => {
  const profile = selectedProfile();
  if (!profile) return;
  window.pet.setDefaultPose(profile.id, (el('default-pose') as HTMLSelectElement).value || null);
});

function renderWorkSettings(): void {
  const profile = selectedProfile();
  input('pet-name').value = profile?.name ?? '';
  (el('agent-kind') as HTMLSelectElement).value = profile?.agent?.kind ?? 'codex';
  (el('agent-permission') as HTMLSelectElement).value = profile?.agent?.permission ?? 'readonly';
  void renderAgentModelOptions(profile?.agent?.model ?? '', profile?.agent?.effort ?? '');
  input('agent-session-id').value = profile?.agent?.sessionId ?? '';
  el('pet-enabled-toggle').textContent = profile?.enabled !== false
    ? '😴 讓這隻寵物休息（釋放資源）'
    : '⏰ 喚醒這隻寵物';
  const path = el('workspace-path');
  path.textContent = profile?.workspacePath ?? '尚未選擇工作目錄';
  path.classList.toggle('empty', !profile?.workspacePath);
  el('change-workspace').textContent = profile?.workspacePath ? '更改工作目錄…' : '選擇工作目錄…';
}

async function loadSelectedPet(notifyMain = true): Promise<void> {
  const profile = selectedProfile();
  if (!profile) return;
  if (notifyMain) await window.pet.selectPet(profile.id);
  lighting = { ...DEFAULT_LIGHTING, ...(profile.lighting ?? {}) };
  sway = { ...DEFAULT_SWAY, ...(profile.sway ?? {}) };
  petState = { ...DEFAULT_STATE, ...(profile.state ?? {}) };
  wardrobeStates = { ...(profile.wardrobe ?? {}) };
  renderPetSelector();
  renderWorkSettings();
  // 打字中(textarea 聚焦)不回寫——存檔廣播回來的 profiles 會蓋掉正在輸入的內容
  if (document.activeElement !== personaEl) personaEl.value = profile.persona ?? '';
  void renderDefaultPose();
  void renderIdleMotions();
  render();
  const front = el('origin-xz');
  const side = el('origin-yz');
  front.textContent = '🧍‍♀️';
  side.textContent = '🚶‍♀️';
  const [savedState, savedLighting, savedSway, wardrobe] = await Promise.all([
    window.pet.getState(profile.id),
    window.pet.getLighting(profile.id),
    window.pet.getSway(profile.id),
    window.pet.getWardrobe(profile.id)
  ]);
  if (selectedPetId !== profile.id) return;
  petState = { ...DEFAULT_STATE, ...(savedState ?? {}) };
  lighting = { ...DEFAULT_LIGHTING, ...(savedLighting ?? {}) };
  sway = { ...DEFAULT_SWAY, ...(savedSway ?? {}) };
  wardrobeStates = { ...wardrobe.states };
  renderWardrobe(wardrobe.list);
  render();
}

function syncProfiles(next: PetProfile[], selectedFromMain: string): void {
  profiles = next;
  if (!profiles.some((profile) => profile.id === selectedPetId)) selectedPetId = selectedFromMain;
  if (!profiles.some((profile) => profile.id === selectedPetId)) selectedPetId = profiles[0]?.id ?? '';
  void loadSelectedPet(false);
}

(el('pet-select') as HTMLSelectElement).addEventListener('change', (event) => {
  selectedPetId = (event.currentTarget as HTMLSelectElement).value;
  void loadSelectedPet(true);
});

el('add-pet').addEventListener('click', async () => {
  const created = await window.pet.createPet();
  selectedPetId = created.id;
  const collection = await window.pet.getPetCollection();
  syncProfiles(collection.pets, collection.selectedPetId);
  activateTab('project');
});

el('remove-pet').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile || profiles.length <= 1) return;
  if (!confirm(`要移除「${profile.name}」嗎？設定檔會保留在 .trash。`)) return;
  if (!await window.pet.removePet(profile.id)) return;
  const collection = await window.pet.getPetCollection();
  selectedPetId = collection.selectedPetId;
  syncProfiles(collection.pets, collection.selectedPetId);
});

input('pet-name').addEventListener('change', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  await window.pet.updatePetMeta(profile.id, { name: input('pet-name').value });
});

/** 各家模型清單快取(main 端另有一層;這層省 IPC)。 */
const modelLists: Partial<Record<AgentKind, AgentModelInfo[]>> = {};

function selectedKind(): AgentKind {
  return (el('agent-kind') as HTMLSelectElement).value === 'claude' ? 'claude' : 'codex';
}

/** 依所選模型重建力度選項(codex 由 model/list 逐模型回報,含 ultra;沒資料退回通用清單)。 */
function rebuildEffortOptions(keep: string): void {
  const effortSelect = el('agent-effort') as HTMLSelectElement;
  const list = modelLists[selectedKind()] ?? [];
  const model = list.find((m) => m.id === (el('agent-model') as HTMLSelectElement).value);
  const efforts = model?.efforts.length
    ? model.efforts
    : [...new Set(list.flatMap((m) => m.efforts))];
  const options = efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh', 'max'];
  effortSelect.innerHTML = '';
  effortSelect.append(new Option('預設', ''));
  for (const effort of options) effortSelect.append(new Option(effort, effort));
  effortSelect.value = options.includes(keep) ? keep : '';
}

/** 抓清單填模型下拉;清單還沒到手前先放目前值,避免面板空白。 */
async function renderAgentModelOptions(keepModel: string, keepEffort: string): Promise<void> {
  const kind = selectedKind();
  const modelSelect = el('agent-model') as HTMLSelectElement;
  const fill = (list: AgentModelInfo[]): void => {
    modelSelect.innerHTML = '';
    modelSelect.append(new Option('預設（CLI 全域設定）', ''));
    for (const m of list) modelSelect.append(new Option(m.isDefault ? `${m.label}（CLI 預設）` : m.label, m.id));
    if (keepModel && !list.some((m) => m.id === keepModel)) {
      modelSelect.append(new Option(`${keepModel}（自訂）`, keepModel));
    }
    modelSelect.value = keepModel;
    rebuildEffortOptions(keepEffort);
  };
  fill(modelLists[kind] ?? []);
  if (!modelLists[kind]) {
    const list = await window.pet.listAgentModels(kind);
    if (list.length) modelLists[kind] = list;
    if (selectedKind() !== kind) return; // 等待期間使用者換了家
    fill(list);
  }
}

async function submitAgentBinding(): Promise<void> {
  const profile = selectedProfile();
  if (!profile) return;
  const kind = selectedKind();
  const sessionId = input('agent-session-id').value.trim();
  const model = (el('agent-model') as HTMLSelectElement).value;
  const effort = (el('agent-effort') as HTMLSelectElement).value;
  const permissionValue = (el('agent-permission') as HTMLSelectElement).value;
  const permission = permissionValue === 'ask' || permissionValue === 'auto' ? permissionValue : undefined;
  await window.pet.updatePetMeta(profile.id, {
    agent: {
      kind,
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(permission ? { permission } : {})
    }
  });
}

el('agent-kind').addEventListener('change', async () => {
  // 換家:舊模型名對新家無效,模型/力度歸回預設再送出
  await renderAgentModelOptions('', '');
  await submitAgentBinding();
});
el('agent-model').addEventListener('change', () => {
  rebuildEffortOptions((el('agent-effort') as HTMLSelectElement).value);
  void submitAgentBinding();
});
el('agent-effort').addEventListener('change', () => void submitAgentBinding());
el('agent-permission').addEventListener('change', () => void submitAgentBinding());
input('agent-session-id').addEventListener('change', () => void submitAgentBinding());

/** 開新對話:與泡泡上的「新對話」鈕走同一條 main 端 IPC(清 sessionId + 關 bridge 舊 session)。 */
el('new-session').addEventListener('click', () => {
  const profile = selectedProfile();
  const button = el('new-session') as HTMLButtonElement;
  if (!profile?.agent?.sessionId) return; // 本來就是新的,不用做事
  window.pet.newSession(profile.id);
  input('agent-session-id').value = '';
  button.disabled = true;
  button.textContent = '已開新對話,下一句從零開始';
  setTimeout(() => {
    button.disabled = false;
    button.textContent = '開新對話（清空上下文）';
  }, 1600);
});

el('pet-enabled-toggle').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  await window.pet.updatePetMeta(profile.id, { enabled: profile.enabled === false });
  // 按鈕文字由 onPetProfiles → syncProfiles → renderWorkSettings 自動更新
});

el('change-workspace').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  const button = el('change-workspace') as HTMLButtonElement;
  button.disabled = true;
  try {
    await window.pet.chooseWorkspace(profile.id);
  } finally {
    button.disabled = false;
  }
});

/* 沙盒設定入口:開既有獨立視窗(高風險設定維持視窗隔離,不內嵌分頁) */
el('open-sandbox').addEventListener('click', () => {
  const profile = selectedProfile();
  if (profile) window.pet.openSandboxSettingsWindow(profile.id);
});

/* 全域:新寵物預設工作根目錄(只影響之後新增的寵物;既有寵物的工作目錄不動) */
function renderWorkspaceRoot(root: string): void {
  el('workspace-root').textContent = root;
}
void window.pet.getWorkspaceRoot().then(renderWorkspaceRoot);
window.pet.onWorkspaceRoot(renderWorkspaceRoot);
el('change-workspace-root').addEventListener('click', async () => {
  const button = el('change-workspace-root') as HTMLButtonElement;
  button.disabled = true; // 防連點(循 change-workspace 慣例)
  try {
    renderWorkspaceRoot(await window.pet.chooseWorkspaceRoot());
  } finally {
    button.disabled = false;
  }
});

window.pet.onPetProfiles(syncProfiles);
window.pet.onSelectedPet((petId) => {
  if (!profiles.some((profile) => profile.id === petId)) return;
  selectedPetId = petId;
  void loadSelectedPet(false);
});

/* ---------- 光源與晃動 ---------- */
/* 點光源是線性衰減(intensity/距離),光源拉遠時 2π 上限根本不夠亮——
 * 點光源模式把強度滑桿上限放大到 12π;切回平行光時上限復原並夾回(平行光 12π 會過曝)。 */
const DIR_INTENSITY_MAX = Math.PI * 2;
const POINT_INTENSITY_MAX = 500;

for (const button of document.querySelectorAll<HTMLButtonElement>('#ltype button')) {
  button.addEventListener('click', () => {
    if (!selectedPetId) return;
    lighting.type = button.dataset['t'] as 'directional' | 'point';
    if (lighting.type === 'directional' && lighting.directional > DIR_INTENSITY_MAX) {
      lighting.directional = DIR_INTENSITY_MAX;
    }
    window.pet.setLighting(selectedPetId, lighting);
    render();
  });
}

const LIGHT_KEYS = ['ambient', 'directional', 'shade'] as const;
const SWAY_KEYS = ['hair', 'cloth', 'chest', 'tail'] as const;
/* 高頻 IPC 節流(50ms trailing):滑桿/拖曳墊的 input 事件可達 60/s,每發都送會讓
 * renderer 每發跑一次套用(shade 是整棵材質樹 traverse);到期時讀當下值,最終值保證送達。 */
let lightingSendTimer: number | null = null;
function sendLightingThrottled(): void {
  if (lightingSendTimer !== null) return;
  lightingSendTimer = window.setTimeout(() => {
    lightingSendTimer = null;
    if (selectedPetId) window.pet.setLighting(selectedPetId, lighting);
  }, 50);
}
let swaySendTimer: number | null = null;
function sendSwayThrottled(): void {
  if (swaySendTimer !== null) return;
  swaySendTimer = window.setTimeout(() => {
    swaySendTimer = null;
    if (selectedPetId) window.pet.setSway(selectedPetId, sway);
  }, 50);
}

for (const key of LIGHT_KEYS) {
  input(key).addEventListener('input', () => {
    if (!selectedPetId) return;
    lighting[key] = Number(input(key).value);
    sendLightingThrottled();
    render();
  });
}
for (const key of SWAY_KEYS) {
  input(key).addEventListener('input', () => {
    if (!selectedPetId) return;
    sway[key] = Number(input(key).value);
    sendSwayThrottled();
    render();
  });
}

/* ---------- 平面拖曳墊 ---------- */
interface PadSpec {
  element: HTMLElement;
  horizontalRange: [number, number];
  verticalRange: [number, number];
  getHorizontal: () => number;
  getVertical: () => number;
  set: (horizontal: number, vertical: number) => void;
}

const pads: PadSpec[] = [];
function makePad(spec: PadSpec): void {
  pads.push(spec);
  const drag = (event: PointerEvent): void => {
    if (!selectedPetId) return;
    const rect = spec.element.getBoundingClientRect();
    const horizontalFraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const verticalFraction = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const horizontal = spec.horizontalRange[0] + horizontalFraction *
      (spec.horizontalRange[1] - spec.horizontalRange[0]);
    const vertical = spec.verticalRange[1] - verticalFraction *
      (spec.verticalRange[1] - spec.verticalRange[0]);
    spec.set(Math.round(horizontal * 100) / 100, Math.round(vertical * 100) / 100);
    render();
  };
  spec.element.addEventListener('pointerdown', (event) => {
    spec.element.setPointerCapture(event.pointerId);
    drag(event);
    const move = (next: PointerEvent): void => drag(next);
    const up = (): void => {
      spec.element.removeEventListener('pointermove', move);
      spec.element.removeEventListener('pointerup', up);
      spec.element.removeEventListener('pointercancel', up);
    };
    spec.element.addEventListener('pointermove', move);
    spec.element.addEventListener('pointerup', up);
    spec.element.addEventListener('pointercancel', up);
  });
}

makePad({
  element: el('light-xy'), horizontalRange: [-100, 100], verticalRange: [-100, 100],
  getHorizontal: () => lighting.x, getVertical: () => lighting.y,
  set: (horizontal, vertical) => {
    lighting.x = horizontal; lighting.y = vertical;
    sendLightingThrottled();
  }
});
makePad({
  element: el('light-yz'), horizontalRange: [-100, 100], verticalRange: [-100, 100],
  getHorizontal: () => lighting.z, getVertical: () => lighting.y,
  set: (horizontal, vertical) => {
    lighting.z = horizontal; lighting.y = vertical;
    sendLightingThrottled();
  }
});
let petStateSendTimer: number | null = null;
function sendPetStateThrottled(): void {
  if (petStateSendTimer !== null) return;
  petStateSendTimer = window.setTimeout(() => {
    petStateSendTimer = null;
    if (selectedPetId) window.pet.setPetState(selectedPetId, petState);
  }, 50);
}
makePad({
  element: el('pet-xy'), horizontalRange: [-6, 6], verticalRange: [-6, 6],
  getHorizontal: () => petState.x, getVertical: () => petState.y,
  set: (horizontal, vertical) => {
    petState.x = horizontal; petState.y = vertical;
    sendPetStateThrottled();
  }
});
makePad({
  element: el('pet-zy'), horizontalRange: [-4, 4], verticalRange: [-6, 6],
  getHorizontal: () => petState.z, getVertical: () => petState.y,
  set: (horizontal, vertical) => {
    petState.z = horizontal; petState.y = vertical;
    sendPetStateThrottled();
  }
});

/* ---------- 服裝 ---------- */
function renderWardrobe(list: WardrobeItem[]): void {
  const box = el('wardrobe');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="empty">此模型沒有可開關的部件</span>';
    return;
  }
  for (const item of list) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = wardrobeStates[item.key] !== false;
    checkbox.addEventListener('change', () => {
      if (!selectedPetId) return;
      wardrobeStates[item.key] = checkbox.checked;
      window.pet.setWardrobe(selectedPetId, item.key, checkbox.checked);
    });
    label.append(checkbox, document.createTextNode(item.label));
    box.appendChild(label);
  }
}

window.pet.onWardrobeList((petId, list) => {
  if (petId === selectedPetId) renderWardrobe(list);
});
window.pet.onAvatarIcons((petId, { front, side }) => {
  if (petId !== selectedPetId) return;
  el('origin-xz').innerHTML = `<img src="${front}" alt="">`;
  const sideOrigin = el('origin-yz');
  sideOrigin.classList.remove('origin-side');
  sideOrigin.innerHTML = `<img src="${side}" alt="">`;
});
window.pet.onState((petId, state) => {
  if (petId !== selectedPetId) return;
  petState = { ...DEFAULT_STATE, ...state };
  render();
});

/* ---------- 顯示與重置 ---------- */
/** render 以 rAF 合併:滑桿 input 與 pad pointermove 每發都叫,一幀最多重繪一次面板。 */
let renderQueued = false;
function render(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}
function renderNow(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#ltype button')) {
    button.classList.toggle('active', button.dataset['t'] === lighting.type);
  }
  // 主光強度上限依光源類型切換(點光源要抵銷距離衰減,需要大得多的上限)
  input('directional').max = String(lighting.type === 'point' ? POINT_INTENSITY_MAX : DIR_INTENSITY_MAX);
  for (const key of LIGHT_KEYS) {
    input(key).value = String(lighting[key]);
    el(`${key}-val`).textContent = key === 'shade'
      ? lighting[key].toFixed(2)
      : key === 'directional' && lighting.type === 'point'
        ? lighting[key].toFixed(1) // 點光源上限 500,π 表示法會變 159π,直接顯示原始值
        : `${(lighting[key] / Math.PI).toFixed(2)} π`;
  }
  for (const key of SWAY_KEYS) {
    input(key).value = String(sway[key]);
    el(`${key}-val`).textContent = `× ${sway[key].toFixed(2)}`;
  }
  for (const pad of pads) {
    const dot = pad.element.querySelector('.dot') as HTMLElement;
    const horizontal = (pad.getHorizontal() - pad.horizontalRange[0]) /
      (pad.horizontalRange[1] - pad.horizontalRange[0]);
    const vertical = (pad.verticalRange[1] - pad.getVertical()) /
      (pad.verticalRange[1] - pad.verticalRange[0]);
    dot.style.left = `${Math.min(100, Math.max(0, horizontal * 100))}%`;
    dot.style.top = `${Math.min(100, Math.max(0, vertical * 100))}%`;
  }
  el('lxy-val').textContent = `${lighting.x.toFixed(1)}, ${lighting.y.toFixed(1)}`;
  el('lyz-val').textContent = `${lighting.y.toFixed(1)}, ${lighting.z.toFixed(1)}`;
  el('pxy-val').textContent = `${petState.x.toFixed(1)}, ${petState.y.toFixed(1)}`;
  el('pzy-val').textContent = `${petState.z.toFixed(1)}, ${petState.y.toFixed(1)}`;
}

el('reset').addEventListener('click', () => {
  if (!selectedPetId) return;
  lighting = { ...DEFAULT_LIGHTING };
  sway = { ...DEFAULT_SWAY };
  petState = { ...DEFAULT_STATE };
  window.pet.setLighting(selectedPetId, lighting);
  window.pet.setSway(selectedPetId, sway);
  window.pet.setPetState(selectedPetId, petState);
  for (const key of Object.keys(wardrobeStates)) {
    if (wardrobeStates[key] === false) window.pet.setWardrobe(selectedPetId, key, true);
    wardrobeStates[key] = true;
  }
  void window.pet.getWardrobe(selectedPetId).then(({ list }) => renderWardrobe(list));
  render();
});

window.pet.getPetCollection().then((collection) => {
  selectedPetId = collection.selectedPetId;
  syncProfiles(collection.pets, collection.selectedPetId);
});
activateTab(initialTab);
render();
