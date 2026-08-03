export interface WorkspacePet {
  id: string;
  workspacePath?: string;
}

export interface PetWorkspaceGroup<T extends WorkspacePet> {
  key: string;
  workspacePath: string | null;
  name: string;
  pets: T[];
}

/** 統一路徑分隔符與結尾斜線，避免同一工作目錄因字串格式不同被拆成兩組。 */
export function normalizeWorkspacePath(path?: string): string | null {
  const slashed = path?.trim().replace(/\\/g, '/');
  if (!slashed) return null;
  if (/^\/+$/u.test(slashed)) return '/';
  return slashed.replace(/\/+$/g, '');
}

/** 泡泡與群組標題只顯示專案根目錄的最後一層。 */
export function workspaceFolderName(path?: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return null;
  if (normalized === '/') return '/';
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

/** 工作目錄相同的寵物會落在同一組；尚未設定者集中於提示組。 */
export function groupPetsByWorkspace<T extends WorkspacePet>(pets: T[]): PetWorkspaceGroup<T>[] {
  const groups = new Map<string, PetWorkspaceGroup<T>>();
  for (const pet of pets) {
    const workspacePath = normalizeWorkspacePath(pet.workspacePath);
    const key = workspacePath ? `workspace:${workspacePath}` : 'workspace:unset';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        workspacePath,
        name: workspaceFolderName(workspacePath ?? undefined) ?? '未設定工作目錄',
        pets: [],
      };
      groups.set(key, group);
    }
    group.pets.push(pet);
  }
  return [...groups.values()];
}
