import type { ControlPetStatus, ControlStatusSnapshot, ControlTaskRecord } from '../shared/chat';
import { normalizeWorkspacePath, workspaceFolderName } from '../shared/petGroups';
import type { ApprovalPolicy, ProjectSandboxSettingsResult, SandboxMode } from '../shared/sandboxSettings';

/* 中控面板 v2:逐寵列表(清醒/休息分區,最後回報新→舊)+ 公用任務發佈(可限定工作區)+ 任務帳本。
 * 資料流:開窗 getControlStatus() 拿 snapshot,之後只訂 control-status-apply 全量快照整區重繪。
 * 重繪會清掉 DOM——各寵輸入框的內容與焦點以 petId 為 key 暫存,重繪後回填。 */

const el = (id: string): HTMLElement => document.getElementById(id)!;

const PHASE_LABEL: Record<ControlPetStatus['phase'], string> = {
  resting: '休息中',
  idle: '閒置',
  working: '工作中',
  awaitingApproval: '等待審批'
};

const STATUS_LABEL: Record<ControlTaskRecord['status'], string> = {
  queued: '排隊中',
  running: '執行中',
  done: '完成',
  failed: '失敗',
  removed: '已移除'
};

let snapshot: ControlStatusSnapshot = { pets: [], tasks: [] };

/* 重繪保留:各寵輸入框草稿與回饋、當下聚焦的輸入框 */
const draftByPet = new Map<string, string>();
const feedbackByPet = new Map<string, { text: string; kind: 'success' | 'error' }>();
let focusedPetInput: string | null = null;

/* ---------- 寵物列 ---------- */
function petRow(pet: ControlPetStatus): HTMLElement {
  const row = document.createElement('div');
  row.className = `pet-row${pet.enabled ? '' : ' resting'}`;

  // 名稱(前置狀態燈點)
  const nameCell = document.createElement('div');
  nameCell.className = 'pet-name-cell';
  const dot = document.createElement('span');
  dot.className = `dot ${pet.phase}`;
  const name = document.createElement('span');
  name.className = 'pet-name';
  name.textContent = pet.name;
  name.title = pet.name;
  nameCell.append(dot, name);

  // 工作區
  const workspace = document.createElement('div');
  workspace.className = 'pet-workspace';
  const folder = workspaceFolderName(pet.workspacePath);
  workspace.textContent = folder ? `📁 ${folder}` : '未設定';
  if (pet.workspacePath) workspace.title = pet.workspacePath;

  // 喚醒/休息
  const toggle = document.createElement('button');
  toggle.className = 'pet-toggle';
  toggle.textContent = pet.enabled ? '休息' : '喚醒';
  toggle.addEventListener('click', () => void window.pet.updatePetMeta(pet.petId, { enabled: !pet.enabled }));

  // 狀態區:phase + 排隊則數
  const status = document.createElement('div');
  status.className = 'pet-status';
  status.textContent = PHASE_LABEL[pet.phase];
  if (pet.queue.length) {
    const count = document.createElement('span');
    count.className = 'queue-count';
    count.textContent = `排隊 ${pet.queue.length}`;
    count.title = pet.queue.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
    status.append(count);
  }

  // 輸入指令區
  const inputCell = document.createElement('div');
  inputCell.className = 'pet-input-cell';
  const inputLine = document.createElement('div');
  inputLine.className = 'pet-input-line';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 1000;
  input.value = draftByPet.get(pet.petId) ?? '';
  input.disabled = !pet.enabled;
  input.placeholder = pet.enabled ? '下指令給這隻寵物…' : '休息中,先喚醒';
  input.addEventListener('input', () => draftByPet.set(pet.petId, input.value));
  input.addEventListener('focus', () => (focusedPetInput = pet.petId));
  input.addEventListener('blur', () => {
    if (focusedPetInput === pet.petId) focusedPetInput = null;
  });
  const send = document.createElement('button');
  send.textContent = '送出';
  send.disabled = !pet.enabled;
  const feedback = document.createElement('div');
  feedback.className = 'pet-feedback';
  const saved = feedbackByPet.get(pet.petId);
  if (saved) {
    feedback.textContent = saved.text;
    feedback.classList.add(saved.kind);
  }
  const submit = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const result = await window.pet.controlEnqueue(text, pet.petId);
      if (result.queued) {
        draftByPet.delete(pet.petId);
        input.value = '';
        feedbackByPet.set(pet.petId, {
          text: result.position === 0 ? '已送出,即將執行' : `已排入第 ${result.position + 1} 位`,
          kind: 'success'
        });
      } else {
        feedbackByPet.set(pet.petId, { text: result.reason ?? '送出失敗', kind: 'error' });
      }
    } finally {
      send.disabled = !pet.enabled;
      const latest = feedbackByPet.get(pet.petId);
      feedback.textContent = latest?.text ?? '';
      feedback.className = `pet-feedback${latest ? ` ${latest.kind}` : ''}`;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit();
  });
  send.addEventListener('click', () => void submit());
  inputLine.append(input, send);
  inputCell.append(inputLine, feedback);

  // 次要操作(靠左,緊鄰喚醒/休息鈕;沙盒設定仍走 Tray,不放中控)
  const more = document.createElement('div');
  more.className = 'pet-more';
  const fresh = document.createElement('button');
  fresh.textContent = '新對話';
  fresh.title = '開新對話(清空上下文)';
  fresh.addEventListener('click', () => {
    if (window.confirm(`確定要為「${pet.name}」開新對話(清空上下文)?`)) window.pet.newSession(pet.petId);
  });
  const chooseDir = document.createElement('button');
  chooseDir.textContent = '目錄';
  chooseDir.title = '選擇工作目錄';
  chooseDir.addEventListener('click', () => void window.pet.chooseWorkspace(pet.petId));
  more.append(fresh, chooseDir);

  row.append(nameCell, workspace, toggle, more, status, inputCell);

  // 等審批:整列下方展開描述 + 允許/拒絕
  if (pet.pendingApproval) {
    const approval = document.createElement('div');
    approval.className = 'approval-row';
    const desc = document.createElement('p');
    desc.className = 'approval-desc';
    desc.textContent = pet.pendingApproval.description;
    desc.title = pet.pendingApproval.description;
    const requestId = pet.pendingApproval.requestId;
    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = '允許';
    allow.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, true));
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = '拒絕';
    deny.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, false));
    approval.append(desc, allow, deny);
    row.append(approval);
  }
  return row;
}

/** 最後回報新→舊;從未對話(0)排最後,同分依名稱穩定排序。 */
function byLastActivity(a: ControlPetStatus, b: ControlPetStatus): number {
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  return a.name.localeCompare(b.name);
}

function renderPetRows(): void {
  const awake = snapshot.pets.filter((pet) => pet.enabled).sort(byLastActivity);
  const resting = snapshot.pets.filter((pet) => !pet.enabled).sort(byLastActivity);
  el('awake-count').textContent = awake.length ? `(${awake.length})` : '';
  el('resting-count').textContent = resting.length ? `(${resting.length})` : '';
  const renderInto = (containerId: string, pets: ControlPetStatus[], emptyText: string): void => {
    const container = el(containerId);
    container.innerHTML = '';
    if (!pets.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = emptyText;
      container.append(note);
      return;
    }
    for (const pet of pets) container.append(petRow(pet));
  };
  renderInto('awake-rows', awake, '沒有清醒的寵物');
  renderInto('resting-rows', resting, '沒有休息中的寵物');
  // 重繪清掉了焦點:把游標還給重繪前正在打字的輸入框
  if (focusedPetInput) {
    const target = focusedPetInput;
    const inputs = document.querySelectorAll<HTMLInputElement>('.pet-row input[type="text"]');
    const pets = [...awake, ...resting];
    inputs.forEach((input, index) => {
      if (pets[index]?.petId === target) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }
}

/* ---------- 公用任務發佈 ---------- */
function renderPublishWorkspaces(): void {
  const picker = el('publish-workspace') as HTMLSelectElement;
  const previous = picker.value;
  picker.innerHTML = '';
  picker.append(new Option('不限工作區(任何空閒寵物可領)', ''));
  const seen = new Set<string>();
  for (const pet of snapshot.pets) {
    const normalized = normalizeWorkspacePath(pet.workspacePath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const option = new Option(`📁 ${workspaceFolderName(normalized) ?? normalized}`, normalized);
    option.title = normalized;
    picker.append(option);
  }
  if ([...picker.options].some((option) => option.value === previous)) picker.value = previous;
}

function setPublishFeedback(message: string, kind: 'neutral' | 'success' | 'error' = 'neutral'): void {
  const feedback = el('publish-feedback');
  feedback.textContent = message;
  feedback.className = `publish-feedback${kind === 'neutral' ? '' : ` ${kind}`}`;
}

el('publish-send').addEventListener('click', async () => {
  const textInput = el('publish-text') as HTMLTextAreaElement;
  const text = textInput.value.trim();
  if (!text) {
    setPublishFeedback('請先輸入任務內容', 'error');
    return;
  }
  const button = el('publish-send') as HTMLButtonElement;
  button.disabled = true;
  try {
    const workspace = (el('publish-workspace') as HTMLSelectElement).value;
    const result = await window.pet.controlEnqueue(text, undefined, workspace || undefined);
    if (!result.queued) {
      setPublishFeedback(result.reason ?? '發佈失敗', 'error'); // 失敗不清輸入框,方便修改重送
      return;
    }
    textInput.value = '';
    setPublishFeedback(result.position === 0 ? '已發佈,空閒寵物即將領取' : `已發佈,池中第 ${result.position + 1} 位`, 'success');
  } finally {
    button.disabled = false;
  }
});

/* ---------- 任務帳本 ---------- */
function taskRow(task: ControlTaskRecord): HTMLElement {
  const row = document.createElement('div');
  row.className = 'task-row';
  const badge = document.createElement('span');
  badge.className = `status-badge ${task.status}`;
  badge.textContent = STATUS_LABEL[task.status];
  const text = document.createElement('span');
  text.className = 'task-text';
  text.textContent = task.text;
  text.title = task.text;
  const assignee = document.createElement('span');
  assignee.className = 'task-cell';
  assignee.textContent = task.assigneeName ?? (task.status === 'queued' ? '待領取' : '—');
  const where = document.createElement('span');
  where.className = 'task-cell';
  const folder = workspaceFolderName(task.workspacePath);
  where.textContent = folder ? `📁 ${folder}` : '—';
  if (task.workspacePath) where.title = task.workspacePath;
  const time = document.createElement('span');
  time.className = 'task-cell task-time';
  time.textContent = new Date(task.enqueuedAt).toLocaleTimeString('zh-TW', { hour12: false });
  const removeCell = document.createElement('span');
  if (task.status === 'queued') {
    const remove = document.createElement('button');
    remove.className = 'task-remove';
    remove.textContent = '✕';
    remove.title = '撤掉這張排隊中的單';
    remove.addEventListener('click', () => {
      // 綁定單走逐寵佇列撤單;公用池單(無 assignee)走公用池撤單
      if (task.assignee) window.pet.removeQueuedMessage(task.assignee, task.id);
      else void window.pet.removeUnboundTask(task.id);
    });
    removeCell.append(remove);
  }
  row.append(badge, text, assignee, where, time, removeCell);
  return row;
}

function renderTasks(): void {
  const table = el('task-table');
  table.innerHTML = '';
  if (!snapshot.tasks.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.style.padding = '10px 12px';
    note.textContent = '還沒有中控指派的任務。上方逐寵下指令或發佈公用任務後,會在這裡追蹤全程狀態。';
    table.append(note);
    return;
  }
  const header = document.createElement('div');
  header.className = 'task-row header';
  for (const label of ['狀態', '任務', '接收者', '執行位置', '時間', '']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);
  for (const task of snapshot.tasks) table.append(taskRow(task));
}

/* ---------- 快照套用 ---------- */
function applySnapshot(next: ControlStatusSnapshot): void {
  snapshot = next;
  renderPetRows();
  renderPublishWorkspaces();
  renderTasks();
  // 沙盒列只在名單/名稱/工作目錄變化時重建——快照每次狀態變更都推,無條件重建會洗掉編輯中的選項
  const signature = snapshot.pets.map((pet) => `${pet.petId}:${pet.name}:${pet.workspacePath ?? ''}`).join('|');
  if (signature !== sandboxSignature) {
    sandboxSignature = signature;
    if (sandboxTabOpened) renderSandboxRows();
  }
}

/* ---------- 分頁 ---------- */
function activateTab(name: string): void {
  if (!document.getElementById(`tab-${name}`)) return;
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset['tab'] === name);
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  el(`tab-${name}`).classList.add('active');
  if (name === 'sandbox') void loadSandboxSettings(); // 切進沙盒分頁時讀取各寵的專案設定
}
document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((button) => {
  button.addEventListener('click', () => activateTab(button.dataset['tab']!));
});
window.pet.onSwitchTab(activateTab); // Tray「沙盒設定…」在視窗已開時切分頁

/* ---------- 沙盒設定分頁(逐寵直列,不折疊;高風險讀寫仍由 main 直改 .codex/config.toml) ---------- */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 寵物集合簽名:只有名單/名稱/工作目錄變了才重建沙盒列——快照每次狀態變更都會推,
 *  無條件重建會洗掉使用者正在編輯的 select 值。 */
let sandboxSignature = '';
/** 逐寵 loadToken:防過期回應蓋掉新值(每列獨立)。 */
const sandboxLoadTokens = new Map<string, number>();
let sandboxTabOpened = false;

interface SandboxRowRefs {
  policy: HTMLSelectElement;
  mode: HTMLSelectElement;
  network: HTMLInputElement;
  apply: HTMLButtonElement;
  status: HTMLElement;
}
const sandboxRowRefs = new Map<string, SandboxRowRefs>();

function setRowStatus(refs: SandboxRowRefs, message: string, kind: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): void {
  refs.status.textContent = message;
  refs.status.className = `sandbox-status${kind === 'neutral' ? '' : ` ${kind}`}`;
}

function sandboxRow(pet: ControlPetStatus): HTMLElement {
  const row = document.createElement('div');
  row.className = `sandbox-row${pet.workspacePath ? '' : ' no-workspace'}`;

  const nameCell = document.createElement('div');
  nameCell.className = 'pet-name-cell';
  const dot = document.createElement('span');
  dot.className = `dot ${pet.phase}`;
  const name = document.createElement('span');
  name.className = 'pet-name';
  name.textContent = pet.name;
  name.title = pet.name;
  nameCell.append(dot, name);

  const workspace = document.createElement('div');
  workspace.className = 'pet-workspace';
  const folder = workspaceFolderName(pet.workspacePath);
  workspace.textContent = folder ? `📁 ${folder}` : '未設定';
  if (pet.workspacePath) workspace.title = pet.workspacePath;

  const policy = document.createElement('select');
  policy.append(
    new Option('需要時詢問（建議）', 'on-request'),
    new Option('只自動允許受信任操作', 'untrusted'),
    new Option('永不詢問（受限操作直接失敗）', 'never')
  );
  const mode = document.createElement('select');
  mode.append(
    new Option('可寫工作目錄（建議）', 'workspace-write'),
    new Option('唯讀', 'read-only'),
    new Option('完整存取（高風險）', 'danger-full-access')
  );
  const networkLabel = document.createElement('label');
  networkLabel.className = 'toggle';
  const network = document.createElement('input');
  network.type = 'checkbox';
  networkLabel.append(network, '網路');
  networkLabel.title = '允許工作區沙盒連線網路(例如 git push)';

  const apply = document.createElement('button');
  apply.className = 'sandbox-apply';
  apply.textContent = '套用';
  const status = document.createElement('div');
  status.className = 'sandbox-status';

  const refs: SandboxRowRefs = { policy, mode, network, apply, status };
  sandboxRowRefs.set(pet.petId, refs);

  const noWorkspace = !pet.workspacePath;
  policy.disabled = mode.disabled = network.disabled = apply.disabled = noWorkspace;
  if (noWorkspace) setRowStatus(refs, '尚未設定工作目錄,先到總覽分頁選「目錄」', 'warning');

  mode.addEventListener('change', () => {
    if (mode.value === 'danger-full-access') {
      setRowStatus(refs, '完整存取會移除一般檔案與網路沙盒限制,只應用於完全信任的專案', 'warning');
    }
  });
  apply.addEventListener('click', async () => {
    const sandboxMode = mode.value as SandboxMode;
    if (sandboxMode === 'danger-full-access' &&
      !window.confirm(`完整存取會移除一般沙盒限制。確定要套用到「${pet.name}」的專案嗎?`)) return;
    apply.disabled = true;
    setRowStatus(refs, '正在直接寫入專案設定…');
    try {
      const result = await withTimeout(window.pet.setProjectSandboxSettings(pet.petId, {
        approvalPolicy: policy.value as ApprovalPolicy,
        sandboxMode,
        networkAccess: network.checked,
      }), 8_000, '寫入逾時；請確認工作目錄所在磁碟是否可用');
      if (!result.ok || !result.settings) setRowStatus(refs, result.message, 'error');
      else setRowStatus(refs, result.message, 'success');
    } catch (error) {
      setRowStatus(refs, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      apply.disabled = false;
    }
  });

  row.append(nameCell, workspace, policy, mode, networkLabel, apply, status);
  return row;
}

async function loadSandboxRow(pet: ControlPetStatus): Promise<void> {
  const refs = sandboxRowRefs.get(pet.petId);
  if (!refs || !pet.workspacePath) return;
  const token = (sandboxLoadTokens.get(pet.petId) ?? 0) + 1;
  sandboxLoadTokens.set(pet.petId, token);
  setRowStatus(refs, '正在讀取專案設定…');
  let result: ProjectSandboxSettingsResult;
  try {
    result = await withTimeout(
      window.pet.getProjectSandboxSettings(pet.petId),
      4_000,
      '讀取逾時；選項仍可操作,可直接套用重試',
    );
  } catch (error) {
    if (sandboxLoadTokens.get(pet.petId) !== token || !sandboxRowRefs.has(pet.petId)) return;
    setRowStatus(refs, error instanceof Error ? error.message : String(error), 'warning');
    return;
  }
  if (sandboxLoadTokens.get(pet.petId) !== token || sandboxRowRefs.get(pet.petId) !== refs) return;
  if (!result.ok || !result.settings) {
    setRowStatus(refs, result.message, 'error');
    return;
  }
  const settings = result.settings;
  refs.policy.value = settings.approvalPolicy ?? 'on-request';
  refs.mode.value = settings.sandboxMode ?? 'workspace-write';
  refs.network.checked = settings.networkAccess ?? true;
  refs.status.title = settings.configPath;
  setRowStatus(refs,
    settings.warnings?.join('；') ??
      (settings.exists ? `已載入 ${settings.configPath}` : '設定檔尚未建立；套用時會安全建立'),
    settings.warnings?.length ? 'warning' : 'neutral');
}

function renderSandboxRows(): void {
  const container = el('sandbox-rows');
  container.innerHTML = '';
  sandboxRowRefs.clear();
  const ordered = [
    ...snapshot.pets.filter((pet) => pet.enabled).sort(byLastActivity),
    ...snapshot.pets.filter((pet) => !pet.enabled).sort(byLastActivity)
  ];
  if (!ordered.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = '沒有寵物';
    container.append(note);
    return;
  }
  for (const pet of ordered) container.append(sandboxRow(pet));
  for (const pet of ordered) void loadSandboxRow(pet); // 並行載入各寵現值
}

function loadSandboxSettings(): void {
  sandboxTabOpened = true;
  renderSandboxRows();
}

/* ---------- 系統操作 ---------- */
el('system-restart').addEventListener('click', () => window.pet.systemRestart());
el('system-quit').addEventListener('click', () => {
  if (window.confirm('確定要結束桌寵系統?')) window.pet.systemQuit();
});

/* ---------- 初始化 ---------- */
window.pet.onControlStatus(applySnapshot);
void window.pet.getControlStatus().then((initial) => {
  if (initial) applySnapshot(initial);
  // 開窗指定分頁(Tray「沙盒設定…」帶 ?tab=sandbox):等首份快照到位才切,沙盒列才有寵物可列
  const tab = new URLSearchParams(location.search).get('tab');
  if (tab && tab !== 'overview') activateTab(tab);
});
