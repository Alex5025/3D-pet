export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface ProjectSandboxSettings {
  workspacePath: string;
  configPath: string;
  exists: boolean;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  networkAccess?: boolean;
  warnings?: string[];
}

export interface ProjectSandboxSettingsInput {
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  networkAccess: boolean;
}

export interface ProjectSandboxSettingsResult {
  ok: boolean;
  message: string;
  settings?: ProjectSandboxSettings;
}
