import { DEFAULT_LIGHTING, DEFAULT_SWAY, type Lighting, type Sway } from './viewer';
import type { PetProfile, PetState, WardrobeItem } from '../preload/index';

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
  el('reset').hidden = name === 'project';
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  button.addEventListener('click', () => activateTab(button.dataset['tab']!));
}
activateTab(new URLSearchParams(location.search).get('tab') ?? 'light');
window.pet.onSwitchTab(activateTab);

/* ---------- 寵物選擇與工作設定 ---------- */
function renderPetSelector(): void {
  const select = el('pet-select') as HTMLSelectElement;
  select.innerHTML = '';
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.enabled ? '' : '（休息中）'}${profile.name}`;
    select.appendChild(option);
  }
  select.value = selectedPetId;
  (el('remove-pet') as HTMLButtonElement).disabled = profiles.length <= 1;
}

function renderWorkSettings(): void {
  const profile = selectedProfile();
  input('pet-name').value = profile?.name ?? '';
  (el('agent-kind') as HTMLSelectElement).value = profile?.agent?.kind ?? 'codex';
  input('agent-session-id').value = profile?.agent?.sessionId ?? '';
  input('pet-enabled').checked = profile?.enabled !== false;
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

async function submitAgentBinding(): Promise<void> {
  const profile = selectedProfile();
  if (!profile) return;
  const kind = (el('agent-kind') as HTMLSelectElement).value === 'claude' ? 'claude' : 'codex';
  const sessionId = input('agent-session-id').value.trim();
  await window.pet.updatePetMeta(profile.id, { agent: sessionId ? { kind, sessionId } : { kind } });
}

el('agent-kind').addEventListener('change', () => void submitAgentBinding());
input('agent-session-id').addEventListener('change', () => void submitAgentBinding());

input('pet-enabled').addEventListener('change', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  await window.pet.updatePetMeta(profile.id, { enabled: input('pet-enabled').checked });
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

window.pet.onPetProfiles(syncProfiles);
window.pet.onSelectedPet((petId) => {
  if (!profiles.some((profile) => profile.id === petId)) return;
  selectedPetId = petId;
  void loadSelectedPet(false);
});

/* ---------- 光源與晃動 ---------- */
for (const button of document.querySelectorAll<HTMLButtonElement>('#ltype button')) {
  button.addEventListener('click', () => {
    if (!selectedPetId) return;
    lighting.type = button.dataset['t'] as 'directional' | 'point';
    window.pet.setLighting(selectedPetId, lighting);
    render();
  });
}

input('point-diameter').addEventListener('input', () => {
  if (!selectedPetId) return;
  lighting.pointDiameter = Number(input('point-diameter').value);
  window.pet.setLighting(selectedPetId, lighting);
  render();
});

const LIGHT_KEYS = ['ambient', 'directional', 'shade'] as const;
const SWAY_KEYS = ['hair', 'cloth', 'chest', 'tail'] as const;
for (const key of LIGHT_KEYS) {
  input(key).addEventListener('input', () => {
    if (!selectedPetId) return;
    lighting[key] = Number(input(key).value);
    window.pet.setLighting(selectedPetId, lighting);
    render();
  });
}
for (const key of SWAY_KEYS) {
  input(key).addEventListener('input', () => {
    if (!selectedPetId) return;
    sway[key] = Number(input(key).value);
    window.pet.setSway(selectedPetId, sway);
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
  element: el('light-xz'), horizontalRange: [-20, 20], verticalRange: [20, -20],
  getHorizontal: () => lighting.x, getVertical: () => lighting.z,
  set: (horizontal, vertical) => {
    lighting.x = horizontal; lighting.z = vertical;
    window.pet.setLighting(selectedPetId, lighting);
  }
});
makePad({
  element: el('light-yz'), horizontalRange: [-20, 20], verticalRange: [-20, 20],
  getHorizontal: () => lighting.z, getVertical: () => lighting.y,
  set: (horizontal, vertical) => {
    lighting.z = horizontal; lighting.y = vertical;
    window.pet.setLighting(selectedPetId, lighting);
  }
});
makePad({
  element: el('pet-xy'), horizontalRange: [-6, 6], verticalRange: [-6, 6],
  getHorizontal: () => petState.x, getVertical: () => petState.y,
  set: (horizontal, vertical) => {
    petState.x = horizontal; petState.y = vertical;
    window.pet.setPetState(selectedPetId, petState);
  }
});
makePad({
  element: el('pet-zy'), horizontalRange: [-4, 4], verticalRange: [-6, 6],
  getHorizontal: () => petState.z, getVertical: () => petState.y,
  set: (horizontal, vertical) => {
    petState.z = horizontal; petState.y = vertical;
    window.pet.setPetState(selectedPetId, petState);
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
function render(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#ltype button')) {
    button.classList.toggle('active', button.dataset['t'] === lighting.type);
  }
  for (const key of LIGHT_KEYS) {
    input(key).value = String(lighting[key]);
    el(`${key}-val`).textContent = key === 'shade'
      ? lighting[key].toFixed(2)
      : `${(lighting[key] / Math.PI).toFixed(2)} π`;
  }
  // 照射直徑只對點光源有意義,平行光時整列收起
  el('point-diameter-row').hidden = lighting.type !== 'point';
  input('point-diameter').value = String(lighting.pointDiameter);
  el('point-diameter-val').textContent = lighting.pointDiameter > 0
    ? `${lighting.pointDiameter.toFixed(1)} m`
    : '無限遠';
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
  el('lxz-val').textContent = `${lighting.x.toFixed(1)}, ${lighting.z.toFixed(1)}`;
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
render();
