export interface StorageLayout { base: string; runtime: string; instance: string; config: string; database: string; logs: string; pid: string; cache: string; temp: string; }
export const RETENTION_MS: number;
export function productionDataDir(env?: NodeJS.ProcessEnv, platform?: string, home?: string): string;
export function isWorktree(root: string): boolean;
export function storageLayout(root: string, env?: NodeJS.ProcessEnv, packaged?: boolean, platform?: string, home?: string): StorageLayout;
export function legacyDataDir(root: string, env?: NodeJS.ProcessEnv, platform?: string): string;
export function assertStopped(pidPath: string): void;
export function prepareStorage(layout: StorageLayout, legacy: string, now?: number): void;
export function pruneLogs(directory: string, now?: number): void;
