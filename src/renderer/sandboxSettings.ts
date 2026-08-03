import type { PetProfile } from '../preload/index';
import { groupPetsByWorkspace } from '../shared/petGroups';
import type {
  ApprovalPolicy,
  ProjectSandboxSettingsResult,
  SandboxMode,
} from '../shared/sandboxSettings';

const el = (id: string): HTMLElement => document.getElementById(id)!;
const select = (id: string): HTMLSelectElement => el(id) as HTMLSelectElement;
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;

let profiles: PetProfile[] = [];
let selectedPetId = '';
let loadToken = 0;

function selectedProfile(): PetProfile | null {
  return profiles.find((profile) => profile.id === selectedPetId) ?? null;
}

function setStatus(message: string, kind: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): void {
  const status = el('status');
  status.textContent = message;
  status.className = `status${kind === 'neutral' ? '' : ` ${kind}`}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function renderPetSelect(): void {
  const picker = select('pet-select');
  picker.innerHTML = '';
  for (const group of groupPetsByWorkspace(profiles)) {
    const options = document.createElement('optgroup');
    options.label = `📁 ${group.name}`;
    for (const profile of group.pets) {
      options.append(new Option(`${profile.enabled ? '' : '（休息中）'}${profile.name}`, profile.id));
    }
    picker.append(options);
  }
  picker.value = selectedPetId;
}

function renderPaths(): PetProfile | null {
  const profile = selectedProfile();
  const workspace = el('workspace-path');
  workspace.textContent = profile?.workspacePath ?? '尚未選擇工作目錄';
  workspace.classList.toggle('empty', !profile?.workspacePath);
  el('config-path').textContent = profile?.workspacePath
    ? `${profile.workspacePath}/.codex/config.toml`
    : '選擇工作目錄後顯示';
  (el('apply') as HTMLButtonElement).disabled = !profile?.workspacePath;
  return profile;
}

async function loadSettings(): Promise<void> {
  const profile = renderPaths();
  if (!profile?.workspacePath) {
    setStatus('請先選擇工作目錄', 'error');
    return;
  }
  const token = ++loadToken;
  const button = el('apply') as HTMLButtonElement;
  button.disabled = true;
  setStatus('正在讀取專案設定…');
  let result: ProjectSandboxSettingsResult;
  try {
    result = await withTimeout(
      window.pet.getProjectSandboxSettings(profile.id),
      4_000,
      '讀取逾時；選項仍可操作，你可以直接套用重試',
    );
  } catch (error) {
    if (token !== loadToken || selectedPetId !== profile.id) return;
    button.disabled = false;
    setStatus(error instanceof Error ? error.message : String(error), 'warning');
    return;
  }
  if (token !== loadToken || selectedPetId !== profile.id) return;
  button.disabled = false;
  if (!result.ok || !result.settings) {
    setStatus(result.message, 'error');
    return;
  }
  const settings = result.settings;
  select('approval-policy').value = settings.approvalPolicy ?? 'on-request';
  select('sandbox-mode').value = settings.sandboxMode ?? 'workspace-write';
  input('network-access').checked = settings.networkAccess ?? true;
  el('config-path').textContent = settings.configPath;
  updateDangerWarning();
  setStatus(
    settings.warnings?.join('；') ??
      (settings.exists ? '已載入目前的專案設定' : '設定檔尚未建立；套用時會安全建立'),
    settings.warnings?.length ? 'warning' : 'neutral',
  );
}

function updateDangerWarning(): void {
  el('danger-warning').hidden = select('sandbox-mode').value !== 'danger-full-access';
}

select('pet-select').addEventListener('change', async () => {
  selectedPetId = select('pet-select').value;
  await window.pet.selectPet(selectedPetId);
  await loadSettings();
});

select('sandbox-mode').addEventListener('change', updateDangerWarning);

el('choose-workspace').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  const button = el('choose-workspace') as HTMLButtonElement;
  button.disabled = true;
  try {
    await window.pet.chooseWorkspace(profile.id);
  } finally {
    button.disabled = false;
  }
});

el('apply').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile?.workspacePath) return;
  const sandboxMode = select('sandbox-mode').value as SandboxMode;
  if (sandboxMode === 'danger-full-access' &&
    !confirm('完整存取會移除一般沙盒限制。確定要套用到這個專案嗎？')) return;
  const button = el('apply') as HTMLButtonElement;
  button.disabled = true;
  setStatus('正在直接寫入專案設定…');
  try {
    const result = await withTimeout(window.pet.setProjectSandboxSettings(profile.id, {
      approvalPolicy: select('approval-policy').value as ApprovalPolicy,
      sandboxMode,
      networkAccess: input('network-access').checked,
    }), 8_000, '寫入逾時；請確認工作目錄所在磁碟是否可用');
    if (selectedPetId !== profile.id) return;
    if (!result.ok || !result.settings) {
      setStatus(result.message, 'error');
      return;
    }
    el('config-path').textContent = result.settings.configPath;
    setStatus(result.message, 'success');
  } catch (error) {
    if (selectedPetId === profile.id) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  } finally {
    if (selectedPetId === profile.id) button.disabled = false;
  }
});

window.pet.onPetProfiles((nextProfiles, nextSelectedPetId) => {
  profiles = nextProfiles;
  if (nextProfiles.some((profile) => profile.id === nextSelectedPetId)) selectedPetId = nextSelectedPetId;
  renderPetSelect();
  void loadSettings();
});

window.pet.onSelectedPet((petId) => {
  if (!profiles.some((profile) => profile.id === petId)) return;
  selectedPetId = petId;
  renderPetSelect();
  void loadSettings();
});

window.pet.getPetCollection().then((collection) => {
  profiles = collection.pets;
  selectedPetId = collection.selectedPetId;
  renderPetSelect();
  void loadSettings();
});
