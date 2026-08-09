# Architecture & development

## Stack

- Electron 33
- strict TypeScript
- electron-vite / Vite
- Three.js
- `@pixiv/three-vrm` and `@pixiv/three-vrm-animation`
- marked + DOMPurify

## Process boundaries

| Entry | Responsibility |
|---|---|
| `src/main/index.ts` | Windows, Tray, persistence, files, power, IPC, and agent lifecycle |
| `src/preload/index.ts` | Minimal APIs exposed through `contextBridge` |
| `src/renderer/main.ts` | Multi-pet runtimes, interaction, hit testing, and bubble coordination |
| `src/renderer/viewer.ts` | Three.js/VRM loading, rendering, animation, and disposal |
| `src/main/agent/` | Codex, Claude, and Mock providers; approvals and sessions |
| `src/shared/` | Cross-process types, i18n, chat, and sandbox schemas |

## Agent bridge

`AgentBridge` exposes a common event stream while delegating execution to an `AgentProvider`:

- Codex runs a persistent `codex app-server` over JSON-RPC.
- Claude spawns the CLI per turn and resumes persisted sessions; a local MCP socket bridges permission prompts.
- Mock supports headless and UI testing.

Every turn must end with exactly one `done` or `error` event. The bridge handles concurrency limits, cancellation, watchdogs, crash recovery, queued messages, and session persistence.

## Renderer principles

`viewer.ts` follows the pixiv/three-vrm official examples as closely as practical. Each pet owns a viewer/runtime so its model, camera, animation, and disposal lifecycle remain isolated. Click-through uses a bone bounding-box precheck followed by an alpha probe for pixel-level hit testing.

## Data and security

- `runtime-data/` contains local profiles, the PID record, and runtime state; it is not versioned.
- `models/` and `motions/` contain local assets.
- Renderers do not receive direct Node.js access.
- Sandbox IPC accepts fixed enums and booleans; main validates workspaces and symbolic links.
- Never commit credentials, tokens, API keys, machine-specific paths, or unlicensed assets.

## Development commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run check:secrets
```

## Test surfaces

- `/vrmtest.html`: model loading, transparency, motions, and interaction.
- `/bubbletest.html`: Markdown, images, approvals, and message queues.
- `VRM_PET_AGENT_SELFTEST=1`: full MockProvider pipeline.
- `VRM_PET_AGENT_SELFTEST=codex|claude`: real CLI e2e; consumes subscription quota.

## Contribution rules

- Two-space indentation, single quotes, semicolons, and trailing commas.
- Keep strict typing and avoid `any`.
- Run typecheck and build plus relevant manual verification.
- Do not commit runtime state, machine-specific paths, or assets without redistribution rights.
