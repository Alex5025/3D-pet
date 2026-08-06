import type { ControlPetStatus, ControlStatusSnapshot, QueuedMessageSummary } from '../shared/chat';
import { groupPetsByWorkspace, workspaceFolderName } from '../shared/petGroups';

/* 中控面板:多寵狀態總覽、指派任務(綁定/公用池)、佇列撤單、審批代答、系統操作。
 * 資料流:開窗 getControlStatus() 拿 snapshot(晚開視窗補齊進行中 turn),之後只訂
 * control-status-apply 全量快照整區重繪——單一資料源,不另訂 pet-profiles 避免兩條流競態。
 * 表單區(textarea/下拉)與列表區分開重繪,快照更新不洗掉打字中的內容。 */

const el = (id: string): HTMLElement => document.getElementById(id)!;

const PHASE_LABEL: Record<ControlPetStatus['phase'], string> = {
  resting: '休息中',
  idle: '閒置',
  working: '工作中',
  awaitingApproval: '等待審批'
};

const UNBOUND_CAP = 20; // 與 chatQueue 的 MAX_UNBOUND_QUEUE 一致(僅顯示用)

let snapshot: ControlStatusSnapshot = { pets: [], unbound: [] };

/* ---------- 指派表單(只在寵物集合變化時重建下拉,保留選取) ---------- */
const POOL_VALUE = ''; // 下拉第一項:公用池(不指定寵物)

function renderAssignTarget(): void {
  const picker = el('assign-target') as HTMLSelectElement;
  const previous = picker.value;
  picker.innerHTML = '';
  picker.append(new Option('公用池(不指定寵物,空閒者領取)', POOL_VALUE));
  const groupable = snapshot.pets.map((pet) => ({ ...pet, id: pet.petId }));
  for (const group of groupPetsByWorkspace(groupable)) {
    const options = document.createElement('optgroup');
    options.label = `📁 ${group.name}`;
    for (const pet of group.pets) {
      const option = new Option(`${pet.enabled ? '' : '(休息中)'}${pet.name}`, pet.petId);
      option.disabled = !pet.enabled; // 休息中不可指派綁定單(main 端也會拒收,這裡先擋)
      options.append(option);
    }
    picker.append(options);
  }
  picker.value = [...picker.options].some((option) => option.value === previous && !option.disabled)
    ? previous
    : POOL_VALUE;
}

function setAssignFeedback(message: string, kind: 'neutral' | 'success' | 'error' = 'neutral'): void {
  const feedback = el('assign-feedback');
  feedback.textContent = message;
  feedback.className = `assign-feedback${kind === 'neutral' ? '' : ` ${kind}`}`;
}

el('assign-send').addEventListener('click', async () => {
  const textInput = el('assign-text') as HTMLTextAreaElement;
  const text = textInput.value.trim();
  if (!text) {
    setAssignFeedback('請先輸入任務內容', 'error');
    return;
  }
  const button = el('assign-send') as HTMLButtonElement;
  button.disabled = true;
  try {
    const target = (el('assign-target') as HTMLSelectElement).value;
    const result = await window.pet.controlEnqueue(text, target || undefined);
    if (!result.queued) {
      setAssignFeedback(result.reason ?? '指派失敗', 'error'); // 失敗不清輸入框,方便修改重送
      return;
    }
    textInput.value = '';
    setAssignFeedback(result.position === 0 ? '已指派,即將開始執行' : `已排入第 ${result.position + 1} 位`, 'success');
  } finally {
    button.disabled = false;
  }
});

/* ---------- 佇列列(公用池與逐寵綁定佇列共用) ---------- */
function queueRow(item: QueuedMessageSummary, onRemove: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'queue-row';
  const badge = document.createElement('span');
  badge.className = `badge ${item.source}`;
  badge.textContent = item.source === 'control' ? '中控' : item.source === 'bubble' ? '泡泡' : '測試';
  const text = document.createElement('span');
  text.className = 'queue-text';
  text.textContent = `${item.text}${item.hasImages ? ' 📎' : ''}`;
  text.title = item.text;
  const remove = document.createElement('button');
  remove.className = 'queue-remove';
  remove.textContent = '✕';
  remove.title = '移除這則任務';
  remove.addEventListener('click', onRemove);
  row.append(badge, text, remove);
  return row;
}

function renderUnbound(): void {
  el('unbound-title').textContent = `公用池(${snapshot.unbound.length}/${UNBOUND_CAP})`;
  const list = el('unbound-list');
  list.innerHTML = '';
  if (!snapshot.unbound.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = '沒有排隊中的公用任務。指派時選「公用池」即可投入。';
    list.append(note);
    return;
  }
  for (const item of snapshot.unbound) {
    list.append(queueRow(item, () => void window.pet.removeUnboundTask(item.id)));
  }
}

/* ---------- 寵物卡片 ---------- */
function petCard(pet: ControlPetStatus): HTMLElement {
  const card = document.createElement('div');
  card.className = 'pet-card';

  const head = document.createElement('div');
  head.className = 'pet-head';
  const dot = document.createElement('span');
  dot.className = `dot ${pet.phase}`;
  const name = document.createElement('span');
  name.className = 'pet-name';
  name.textContent = pet.name;
  const phase = document.createElement('span');
  phase.className = 'phase-text';
  phase.textContent = PHASE_LABEL[pet.phase];
  head.append(dot, name, phase);
  card.append(head);

  const workspace = document.createElement('div');
  workspace.className = 'pet-workspace';
  const folder = workspaceFolderName(pet.workspacePath);
  workspace.textContent = folder ? `📁 ${folder}` : '未設定工作目錄';
  if (pet.workspacePath) workspace.title = pet.workspacePath;
  card.append(workspace);

  if (pet.pendingApproval) {
    const box = document.createElement('div');
    box.className = 'approval-box';
    const desc = document.createElement('p');
    desc.className = 'approval-desc';
    desc.textContent = pet.pendingApproval.description;
    const buttons = document.createElement('div');
    buttons.className = 'approval-buttons';
    const requestId = pet.pendingApproval.requestId;
    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = '允許';
    allow.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, true));
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = '拒絕';
    deny.addEventListener('click', () => window.pet.chatApproval(pet.petId, requestId, false));
    buttons.append(allow, deny);
    box.append(desc, buttons);
    card.append(box);
  }

  if (pet.queue.length) {
    const queueBox = document.createElement('div');
    queueBox.className = 'pet-queue';
    for (const item of pet.queue) {
      queueBox.append(queueRow(item, () => window.pet.removeQueuedMessage(pet.petId, item.id)));
    }
    card.append(queueBox);
  }

  const actions = document.createElement('div');
  actions.className = 'pet-actions';
  const toggle = document.createElement('button');
  toggle.textContent = pet.enabled ? '休息' : '喚醒';
  toggle.addEventListener('click', () => void window.pet.updatePetMeta(pet.petId, { enabled: !pet.enabled }));
  const fresh = document.createElement('button');
  fresh.textContent = '開新對話';
  fresh.addEventListener('click', () => {
    if (window.confirm(`確定要為「${pet.name}」開新對話(清空上下文)?`)) window.pet.newSession(pet.petId);
  });
  const chooseDir = document.createElement('button');
  chooseDir.textContent = '工作目錄…';
  chooseDir.addEventListener('click', () => void window.pet.chooseWorkspace(pet.petId));
  const sandbox = document.createElement('button');
  sandbox.textContent = '沙盒設定…';
  sandbox.addEventListener('click', () => window.pet.openSandboxSettingsWindow(pet.petId));
  actions.append(toggle, fresh, chooseDir, sandbox);
  card.append(actions);
  return card;
}

function renderPets(): void {
  const cards = el('pet-cards');
  cards.innerHTML = '';
  for (const pet of snapshot.pets) cards.append(petCard(pet));
}

/* ---------- 快照套用 ---------- */
function applySnapshot(next: ControlStatusSnapshot): void {
  snapshot = next;
  renderAssignTarget();
  renderUnbound();
  renderPets();
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
});
