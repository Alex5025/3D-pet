import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  ApprovalPolicy,
  ProjectSandboxSettings,
  ProjectSandboxSettingsInput,
  SandboxMode,
} from '../shared/sandboxSettings';

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(['untrusted', 'on-request', 'never']);
const SANDBOX_MODES = new Set<SandboxMode>(['read-only', 'workspace-write', 'danger-full-access']);
const MANAGED_COMMENT = '# 由 VRM 桌寵「沙盒設定」直接管理（不經 AI）';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function configPath(workspacePath: string, create: boolean): Promise<string> {
  if (!isAbsolute(workspacePath) || !(await stat(workspacePath)).isDirectory()) {
    throw new Error('工作目錄不存在或不是資料夾');
  }
  const directory = join(workspacePath, '.codex');
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error('基於安全考量，不寫入符號連結的 .codex 目錄');
    if (!info.isDirectory()) throw new Error('.codex 已存在但不是資料夾');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    if (!create) return join(directory, 'config.toml');
    await mkdir(directory, { recursive: false });
  }
  const path = join(directory, 'config.toml');
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error('基於安全考量，不寫入符號連結的 config.toml');
    }
    if (!info.isFile()) throw new Error('config.toml 已存在但不是一般檔案');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return path;
}

/** 只讀 root table 的字串鍵；其他 table 中同名鍵不算專案全域設定。 */
function rootString(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`));
    if (match) return match[1];
  }
  return undefined;
}

function hasRootKey(content: string, key: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) return true;
  }
  return false;
}

function networkValue(content: string): boolean | undefined {
  let table = '';
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]/);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const dotted = table === ''
      ? line.match(/^\s*sandbox_workspace_write\.network_access\s*=\s*(true|false)/)
      : null;
    const nested = table === 'sandbox_workspace_write'
      ? line.match(/^\s*network_access\s*=\s*(true|false)/)
      : null;
    const value = dotted?.[1] ?? nested?.[1];
    if (value) return value === 'true';
  }
  return undefined;
}

export function parseProjectSandboxConfig(
  workspacePath: string,
  path: string,
  content: string,
): ProjectSandboxSettings {
  const approval = rootString(content, 'approval_policy');
  const sandbox = rootString(content, 'sandbox_mode');
  const approvalSupported = APPROVAL_POLICIES.has(approval as ApprovalPolicy);
  const sandboxSupported = SANDBOX_MODES.has(sandbox as SandboxMode);
  const warnings = [
    hasRootKey(content, 'approval_policy') && !approvalSupported
      ? '現有 approval_policy 使用進階格式；套用會改成此頁選擇的標準模式'
      : '',
    hasRootKey(content, 'sandbox_mode') && !sandboxSupported
      ? '現有 sandbox_mode 無法辨識；套用會改成此頁選擇的標準模式'
      : '',
  ].filter(Boolean);
  return {
    workspacePath,
    configPath: path,
    exists: true,
    approvalPolicy: approvalSupported
      ? approval as ApprovalPolicy
      : undefined,
    sandboxMode: sandboxSupported
      ? sandbox as SandboxMode
      : undefined,
    networkAccess: networkValue(content),
    warnings: warnings.length ? warnings : undefined,
  };
}

function withoutManagedRootKeys(lines: string[]): string[] {
  let inRoot = true;
  return lines.filter((line) => {
    if (/^\s*\[/.test(line)) inRoot = false;
    if (!inRoot) return true;
    if (line.trim() === MANAGED_COMMENT) return false;
    return !/^\s*(approval_policy|sandbox_mode|sandbox_workspace_write\.network_access)\s*=/.test(line);
  });
}

function setNetworkAccess(lines: string[], enabled: boolean): string[] {
  let tableStart = -1;
  let tableEnd = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(/^\s*\[([^\]]+)]/);
    if (!header) continue;
    if (tableStart >= 0) {
      tableEnd = index;
      break;
    }
    if (header[1].trim() === 'sandbox_workspace_write') tableStart = index;
  }
  if (tableStart < 0) {
    const separator = lines.length && lines[lines.length - 1].trim() ? [''] : [];
    return [...lines, ...separator, '[sandbox_workspace_write]', `network_access = ${enabled}`];
  }
  const result = [...lines];
  let replaced = false;
  for (let index = tableStart + 1; index < tableEnd; index++) {
    if (!/^\s*network_access\s*=/.test(result[index])) continue;
    if (!replaced) {
      result[index] = `network_access = ${enabled}`;
      replaced = true;
    } else {
      result.splice(index--, 1);
      tableEnd--;
    }
  }
  if (!replaced) result.splice(tableStart + 1, 0, `network_access = ${enabled}`);
  return result;
}

export function updateProjectSandboxConfig(
  content: string,
  settings: ProjectSandboxSettingsInput,
): string {
  const original = content.replace(/\r\n/g, '\n').split('\n');
  while (original.length && !original[original.length - 1]) original.pop();
  const body = withoutManagedRootKeys(original);
  while (body.length && !body[0].trim()) body.shift();
  const prefix = [
    MANAGED_COMMENT,
    `approval_policy = "${settings.approvalPolicy}"`,
    `sandbox_mode = "${settings.sandboxMode}"`,
    '',
  ];
  return `${setNetworkAccess([...prefix, ...body], settings.networkAccess).join('\n').trimEnd()}\n`;
}

export async function readProjectSandboxSettings(workspacePath: string): Promise<ProjectSandboxSettings> {
  const path = await configPath(workspacePath, false);
  try {
    return parseProjectSandboxConfig(workspacePath, path, await readFile(path, 'utf8'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return { workspacePath, configPath: path, exists: false };
  }
}

export async function writeProjectSandboxSettings(
  workspacePath: string,
  settings: ProjectSandboxSettingsInput,
): Promise<ProjectSandboxSettings> {
  if (!APPROVAL_POLICIES.has(settings.approvalPolicy) || !SANDBOX_MODES.has(settings.sandboxMode) ||
    typeof settings.networkAccess !== 'boolean') {
    throw new Error('沙盒設定值不合法');
  }
  const path = await configPath(workspacePath, true);
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const next = updateProjectSandboxConfig(current, settings);
  const temporary = `${path}.vrm-pet-${process.pid}.tmp`;
  await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  return parseProjectSandboxConfig(workspacePath, path, next);
}
