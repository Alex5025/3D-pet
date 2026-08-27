import type { ControlPetStatus, ControlStatusSnapshot, ControlTaskRecord } from '../shared/chat';
import { normalizeWorkspacePath, workspaceFolderName } from '../shared/petGroups';
import { setLocale, t, type Locale } from '../shared/i18n';
import { applyI18nDom } from './i18nDom';
import { bcp47 } from '../shared/i18n';
import type { ApprovalPolicy, ProjectSandboxSettingsResult, SandboxMode } from '../shared/sandboxSettings';

/* 中控面板 v2:逐寵列表(清醒/休息分區,最後回報新→舊)+ 公用任務發佈(可限定工作區)+ 任務帳本。
 * 資料流:開窗 getControlStatus() 拿 snapshot,之後只訂 control-status-apply 全量快照整區重繪。
 * 重繪會清掉 DOM——各寵輸入框的內容與焦點以 petId 為 key 暫存,重繪後回填。 */

const el = (id: string): HTMLElement => document.getElementById(id)!;

/* 狀態標籤用函式取值:模組常數會在載入時凍住舊語言(i18n 陷阱) */
const phaseLabel = (phase: ControlPetStatus['phase']): string => ({
  resting: t('control.phaseResting'),
  idle: t('control.phaseIdle'),
  working: t('control.phaseWorking'),
  awaitingApproval: t('control.phaseAwaitingApproval')
}[phase]);

const statusLabel = (status: ControlTaskRecord['status']): string => ({
  queued: t('control.statusQueued'),
  running: t('control.statusRunning'),
  done: t('control.statusDone'),
  failed: t('control.statusFailed'),
  removed: t('control.statusRemoved')
}[status]);

let snapshot: ControlStatusSnapshot = { pets: [], tasks: [] };

/* 重繪保留:各寵輸入框草稿與回饋、當下聚焦的輸入框 */
const draftByPet = new Map<string, string>();
const feedbackByPet = new Map<string, { text: string; kind: 'success' | 'error' }>();
let focusedPetInput: string | null = null;
/* 就地改名中的寵物與草稿:快照每 50ms 就可能重繪整個列表,狀態存在模組層才不會打到一半被洗掉 */
let renamingPetId: string | null = null;
let renameDraft = '';

/* ---------- 寵物列 ---------- */

/** 名稱標籤:點一下切成輸入框(就地改名);hover 提示完整名稱與可改名。 */
function nameLabel(pet: ControlPetStatus): HTMLElement {
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'pet-name';
  name.textContent = pet.name;
  name.title = t('control.renameHint', { name: pet.name });
  name.addEventListener('click', () => {
    renamingPetId = pet.petId;
    renameDraft = pet.name;
    renderPetRows();
  });
  return name;
}

/** 改名輸入框:Enter/失焦送出、Esc 取消;空白或未變更視同取消。 */
function renameField(pet: ControlPetStatus): HTMLElement {
  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'pet-name-edit';
  field.maxLength = 40; // 同設定面板的寵物名稱上限
  field.value = renameDraft;
  field.setAttribute('aria-label', t('control.renameHint', { name: pet.name }));
  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return; // Enter 會連帶觸發 blur,只認第一次
    settled = true;
    const next = field.value.trim();
    renamingPetId = null;
    renameDraft = '';
    if (commit && next && next !== pet.name) void window.pet.updatePetMeta(pet.petId, { name: next });
    renderPetRows(); // 送出後等快照回來會慢半拍,先還原成標籤
  };
  field.addEventListener('input', () => (renameDraft = field.value));
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  field.addEventListener('blur', () => finish(true));
  return field;
}
/** 清醒寵物卡片:標頭(狀態點/名稱/工作區膠囊/休息鈕)+ 狀態列 + 審批橫幅 + 輸入列。 */
function petCard(pet: ControlPetStatus): HTMLElement {
  const card = document.createElement('div');
  card.className = 'pet-card';

  // 標頭:狀態燈點 + 名稱(可就地改名)+ 工作區膠囊 + 休息鈕
  const head = document.createElement('div');
  head.className = 'pet-head';
  const dot = document.createElement('span');
  dot.className = `dot ${pet.phase}`;

  // 工作區
  const workspace = document.createElement('div');
  workspace.className = 'pet-workspace';
  const folder = workspaceFolderName(pet.workspacePath);
  workspace.textContent = folder ? `📁 ${folder}` : t('common.notSet');
  if (pet.workspacePath) workspace.title = pet.workspacePath;

  // 喚醒/休息
  const toggle = document.createElement('button');
  toggle.className = 'pet-toggle';
  toggle.textContent = pet.enabled ? t('control.rest') : t('control.wake');
  toggle.addEventListener('click', () => void window.pet.updatePetMeta(pet.petId, { enabled: !pet.enabled }));

  head.append(dot, renamingPetId === pet.petId ? renameField(pet) : nameLabel(pet), workspace, toggle);

  // 狀態列:phase + 排隊則數,次要操作靠右
  const statusLine = document.createElement('div');
  statusLine.className = 'pet-status-line';
  const status = document.createElement('div');
  status.className = 'pet-status';
  status.textContent = phaseLabel(pet.phase);
  if (pet.queue.length) {
    const count = document.createElement('span');
    count.className = 'queue-count';
    count.textContent = t('control.queueN', { n: pet.queue.length });
    count.title = pet.queue.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
    status.append(count);
  }

  // 輸入指令區
  const inputLine = document.createElement('div');
  inputLine.className = 'pet-input-line';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 1000;
  input.value = draftByPet.get(pet.petId) ?? '';
  input.disabled = !pet.enabled;
  input.placeholder = pet.enabled ? t('control.inputPlaceholder') : t('control.inputResting');
  input.addEventListener('input', () => draftByPet.set(pet.petId, input.value));
  input.addEventListener('focus', () => (focusedPetInput = pet.petId));
  input.addEventListener('blur', () => {
    if (focusedPetInput === pet.petId) focusedPetInput = null;
  });
  const send = document.createElement('button');
  send.textContent = t('control.send');
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
          text: result.position === 0 ? t('control.sendOkNow') : t('control.sendOkQueued', { n: result.position + 1 }),
          kind: 'success'
        });
      } else {
        feedbackByPet.set(pet.petId, { text: result.reason ?? t('control.sendFail'), kind: 'error' });
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

  // 次要操作(狀態列右側小字鈕;沙盒設定仍走 Tray,不放中控)
  const more = document.createElement('div');
  more.className = 'pet-more';
  const fresh = document.createElement('button');
  fresh.textContent = t('control.newSession');
  fresh.title = t('control.newSessionTitle');
  fresh.addEventListener('click', () => {
    if (window.confirm(t('control.confirmNewSession', { name: pet.name }))) window.pet.newSession(pet.petId);
  });
  const chooseDir = document.createElement('button');
  chooseDir.textContent = t('control.chooseDir');
  chooseDir.title = t('control.chooseDirTitle');
  chooseDir.addEventListener('click', () => void window.pet.chooseWorkspace(pet.petId));
  more.append(fresh, chooseDir);
  statusLine.append(status, more);

  card.append(head, statusLine);

  // 等審批:醒目橫幅嵌在輸入列上方(描述 + 允許/拒絕)
  if (pet.pendingApproval) {
    const approval = document.createElement('div');
    approval.className = 'approval-banner';
    const desc = document.createElement('p');
    desc.className = 'approval-desc';
    desc.textContent = pet.pendingApproval.description;
    desc.title = pet.pendingApproval.description;
    const requestId = pet.pendingApproval.requestId;
    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = t('common.allow');
    allow.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, true));
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = t('common.deny');
    deny.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, false));
    approval.append(desc, allow, deny);
    card.append(approval);
  }

  card.append(inputLine, feedback);
  return card;
}

/** 休息中寵物收成膠囊:狀態點 + 名稱 + 喚醒鈕;完整工作區路徑放 title。 */
function restingItem(pet: ControlPetStatus): HTMLElement {
  const item = document.createElement('span');
  item.className = 'resting-item';
  const dot = document.createElement('span');
  dot.className = `dot ${pet.phase}`;
  const name = document.createElement('span');
  name.className = 'resting-name';
  name.textContent = pet.name;
  const folder = workspaceFolderName(pet.workspacePath);
  name.title = folder ? `${pet.name} — 📁 ${pet.workspacePath}` : pet.name;
  const wake = document.createElement('button');
  wake.textContent = t('control.wake');
  wake.addEventListener('click', () => void window.pet.updatePetMeta(pet.petId, { enabled: true }));
  item.append(dot, name, wake);
  return item;
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
  const renderInto = (
    containerId: string,
    pets: ControlPetStatus[],
    emptyText: string,
    build: (pet: ControlPetStatus) => HTMLElement
  ): void => {
    const container = el(containerId);
    container.innerHTML = '';
    if (!pets.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = emptyText;
      container.append(note);
      return;
    }
    for (const pet of pets) container.append(build(pet));
  };
  renderInto('awake-rows', awake, t('control.noAwake'), petCard);
  renderInto('resting-rows', resting, t('control.noResting'), restingItem);
  // 改名中的輸入框是重繪後才生出來的新元素,焦點與游標位置要補回去
  if (renamingPetId) {
    const field = document.querySelector<HTMLInputElement>('.pet-name-edit');
    if (field && document.activeElement !== field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }
  // 重繪清掉了焦點:把游標還給重繪前正在打字的輸入框(輸入框只在清醒卡片上)
  if (focusedPetInput) {
    const target = focusedPetInput;
    const inputs = document.querySelectorAll<HTMLInputElement>('.pet-card input[type="text"]');
    inputs.forEach((input, index) => {
      if (awake[index]?.petId === target) {
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
  picker.append(new Option(t('control.anyWorkspace'), ''));
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
    setPublishFeedback(t('control.enterTask'), 'error');
    return;
  }
  const button = el('publish-send') as HTMLButtonElement;
  button.disabled = true;
  try {
    const workspace = (el('publish-workspace') as HTMLSelectElement).value;
    const result = await window.pet.controlEnqueue(text, undefined, workspace || undefined);
    if (!result.queued) {
      setPublishFeedback(result.reason ?? t('control.publishFail'), 'error'); // 失敗不清輸入框,方便修改重送
      return;
    }
    textInput.value = '';
    setPublishFeedback(result.position === 0 ? t('control.publishOkNow') : t('control.publishOkQueued', { n: result.position + 1 }), 'success');
  } finally {
    button.disabled = false;
  }
});

/* ---------- 任務帳本 ---------- */
function taskRow(task: ControlTaskRecord): HTMLElement {
  const row = document.createElement('div');
  // 失敗任務要一眼可辨:左緣紅條(DESIGN-TODO §3)
  row.className = `task-row${task.status === 'failed' ? ' failed' : ''}`;
  const badge = document.createElement('span');
  badge.className = `status-badge ${task.status}`;
  badge.textContent = statusLabel(task.status);
  const text = document.createElement('span');
  text.className = 'task-text';
  text.textContent = task.text;
  text.title = task.text;
  const assignee = document.createElement('span');
  assignee.className = 'task-cell';
  assignee.textContent = task.assigneeName ?? (task.status === 'queued' ? t('control.unclaimed') : '—');
  const where = document.createElement('span');
  where.className = 'task-cell';
  const folder = workspaceFolderName(task.workspacePath);
  where.textContent = folder ? `📁 ${folder}` : '—';
  if (task.workspacePath) where.title = task.workspacePath;
  const time = document.createElement('span');
  time.className = 'task-cell task-time';
  time.textContent = new Date(task.enqueuedAt).toLocaleTimeString(bcp47(), { hour12: false });
  const removeCell = document.createElement('span');
  if (task.status === 'queued') {
    const remove = document.createElement('button');
    remove.className = 'task-remove';
    remove.textContent = '✕';
    remove.title = t('control.removeTaskTitle');
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
    note.textContent = t('control.tasksEmpty');
    table.append(note);
    return;
  }
  const header = document.createElement('div');
  header.className = 'task-row header';
  for (const label of [t('control.colStatus'), t('control.colTask'), t('control.colAssignee'), t('control.colWhere'), t('control.colTime'), '']) {
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
  workspace.textContent = folder ? `📁 ${folder}` : t('common.notSet');
  if (pet.workspacePath) workspace.title = pet.workspacePath;

  const policy = document.createElement('select');
  policy.append(
    new Option(t('control.policyOnRequest'), 'on-request'),
    new Option(t('control.policyUntrusted'), 'untrusted'),
    new Option(t('control.policyNever'), 'never')
  );
  const mode = document.createElement('select');
  mode.append(
    new Option(t('control.modeWorkspaceWrite'), 'workspace-write'),
    new Option(t('control.modeReadOnly'), 'read-only'),
    new Option(t('control.modeFullAccess'), 'danger-full-access')
  );
  const networkLabel = document.createElement('label');
  networkLabel.className = 'toggle';
  const network = document.createElement('input');
  network.type = 'checkbox';
  networkLabel.append(network, t('control.network'));
  networkLabel.title = t('control.networkTitle');

  const apply = document.createElement('button');
  apply.className = 'sandbox-apply';
  apply.textContent = t('control.apply');
  const status = document.createElement('div');
  status.className = 'sandbox-status';

  const refs: SandboxRowRefs = { policy, mode, network, apply, status };
  sandboxRowRefs.set(pet.petId, refs);

  const noWorkspace = !pet.workspacePath;
  policy.disabled = mode.disabled = network.disabled = apply.disabled = noWorkspace;
  if (noWorkspace) setRowStatus(refs, t('control.rowNoWorkspace'), 'warning');

  mode.addEventListener('change', () => {
    if (mode.value === 'danger-full-access') {
      setRowStatus(refs, t('control.dangerWarn'), 'warning');
    }
  });
  apply.addEventListener('click', async () => {
    const sandboxMode = mode.value as SandboxMode;
    if (sandboxMode === 'danger-full-access' &&
      !window.confirm(t('control.confirmDanger', { name: pet.name }))) return;
    apply.disabled = true;
    setRowStatus(refs, t('control.applying'));
    try {
      const result = await withTimeout(window.pet.setProjectSandboxSettings(pet.petId, {
        approvalPolicy: policy.value as ApprovalPolicy,
        sandboxMode,
        networkAccess: network.checked,
      }), 8_000, t('control.writeTimeout'));
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
  setRowStatus(refs, t('control.loadingSandbox'));
  let result: ProjectSandboxSettingsResult;
  try {
    result = await withTimeout(
      window.pet.getProjectSandboxSettings(pet.petId),
      4_000,
      t('control.loadTimeout'),
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
      (settings.exists ? t('control.loadedConfig', { path: settings.configPath }) : t('control.configNotCreated')),
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
    note.textContent = t('control.noPets');
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
  if (window.confirm(t('control.confirmQuit'))) window.pet.systemQuit();
});

/* ---------- 語言下拉(全域設定,存 registry.locale) ---------- */
const localeSelect = el('ui-locale') as HTMLSelectElement;
localeSelect.addEventListener('change', () => {
  void window.pet.setLocale(localeSelect.value); // main 廣播 locale-apply 回來,重繪走訂閱
});

/* ---------- 初始化(先拿語言再首次渲染) ---------- */
window.pet.onLocale((next) => {
  setLocale(next as Locale);
  applyI18nDom();
  sandboxSignature = ''; // 沙盒列文字含翻譯:強制繞過簽名快取,applySnapshot 內會重建
  applySnapshot(snapshot); // 全量快照重繪天然支援換語言
});
window.pet.onControlStatus(applySnapshot);
void window.pet.getLocale().then((locale) => {
  setLocale(locale as Locale);
  applyI18nDom();
  return Promise.all([window.pet.getControlStatus(), window.pet.getLocalePref()]);
}).then(([initial, pref]) => {
  localeSelect.value = pref; // ''=跟隨系統
  if (initial) applySnapshot(initial);
  // 開窗指定分頁(Tray「沙盒設定…」帶 ?tab=sandbox):等首份快照到位才切,沙盒列才有寵物可列
  const tab = new URLSearchParams(location.search).get('tab');
  if (tab && tab !== 'overview') activateTab(tab);
});

/* 全域:新寵物預設工作根目錄(自設定面板搬入,循語言下拉的中控慣例) */
const renderWorkspaceRoot = (root: string): void => {
  el('workspace-root').textContent = root;
};
void window.pet.getWorkspaceRoot().then(renderWorkspaceRoot);
window.pet.onWorkspaceRoot(renderWorkspaceRoot);
el('change-workspace-root').addEventListener('click', async () => {
  const button = el('change-workspace-root') as HTMLButtonElement;
  button.disabled = true; // 防連點
  try {
    renderWorkspaceRoot(await window.pet.chooseWorkspaceRoot());
  } finally {
    button.disabled = false;
  }
});

/* 瀏覽器自驗鉤子:中控沒有獨立驗證頁,直接開 control.html 灌快照即可測列表行為
 * (改名的重繪保留特別需要——快照每 50ms 就可能重繪整個列表)。 */
declare global {
  interface Window {
    __applySnapshot: (next: ControlStatusSnapshot) => void;
  }
}
window.__applySnapshot = applySnapshot;
