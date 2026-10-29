import type { AgentBinding } from './agentEvents';

export interface PetProject {
  workspacePath: string;
  agent?: AgentBinding;
}
export interface LocalPet {
  id: string;
  name: string;
  enabled: boolean;
  projects: PetProject[];
  workspacePath?: string;
  state?: { x: number; y: number; z: number; rotY: number; camZ: number };
  personaVersion?: string;
}
