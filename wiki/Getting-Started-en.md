# Getting started

## What is 3D-pet?

3D-pet is a VRM desktop-pet system for macOS. Each pet can be connected to Codex or Claude Code and assigned its own workspace, model, reasoning effort, permissions, and personality. The pets can edit code, run tests, and write documentation—not merely chat.

## Requirements

- macOS; Apple Silicon is the tested platform
- Node.js 22 or later
- npm
- At least one installed and authenticated agent CLI:
  - OpenAI Codex CLI
  - Claude Code CLI
- Properly licensed `.vrm` models and `.vrma` motions

The project uses subscription-based local CLI authentication. Do not place API keys in the repository.

## Install and launch

```bash
git clone <YOUR_GITLAB_PROJECT_URL>
cd 3D-pet
npm install
npm run dev
```

The character appears in a transparent desktop overlay. Move the pointer over a pet to interact with it; transparent regions pass clicks through when the pointer leaves.

## First-time setup

1. Right-click a pet or open the Tray menu.
2. Open **Settings → Work (AI assistant)**.
3. Select Codex or Claude Code.
4. Choose the model, reasoning effort, and permission level.
5. Select a workspace, or use the default workspace created for a new pet.
6. Optionally define the pet's personality.
7. Put VRM assets in `models/`, or select a model from the menu.

## Basic controls

| Input | Action |
|---|---|
| Left-button drag | Move the pet |
| Right-button drag | Rotate the pet |
| Mouse wheel | Scale the pet |
| Hover over a pet | Open its speech bubble |
| Enter | Send a message |
| Shift+Enter | Insert a line break |
| Drop onto the illuminated receiver | Add a reference, replace a VRM, or play a VRMA |

## Verify the installation

```bash
npm run typecheck
npm run build
```

Run the agent pipeline without consuming subscription quota:

```bash
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev
```

## Next steps

- [User guide](User-Guide-en)
- [Architecture & development](Architecture-en)
