# 3D-pet — An AI Engineering Team That Lives on Your Desktop

[繁體中文](README.md) | **English** | [日本語](README.ja.md)

VRM 3D desktop pets on a transparent macOS overlay (Electron + three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)) — but they're not just decoration. **Each pet is bound to a real coding agent** (OpenAI Codex, Claude Code, or Google Antigravity) and a working directory: say the word in its speech bubble and your pet goes off to edit code, run tests, and write docs — asking for your approval before anything risky, then reporting back with expressions and motions.

One pet is a desktop companion. A few of them are an engineering team.

## Why It's Special

- **Pets that actually work** — not a chat toy. Each pet has its own agent, model, reasoning effort, persona, and working directory. Drag files over as reference material, paste screenshots for it to read — it does real work in your repo.
- **No API bills** — everything runs through locally installed CLIs with subscription login (Codex CLI / Claude Code / Antigravity CLI). No API keys, no surprise invoices.
- **Multi-pet collaboration** — chat has a queue (the input box never locks; messages line up and run in order). Assign tasks to a specific pet or drop them into a **shared task pool** for any idle pet to claim. The **Control Panel** shows every pet's status on one page, lets you answer approvals, and dispatches work centrally.
- **Permissions that hold** — three levels (read-only / workspace-write with approval / full-auto). When you reject an approval you can attach feedback, and the AI adjusts course within the same turn. Codex sandbox policy is managed directly by the main process — never by the AI, never via arbitrary scripts.
- **Desktop-pet polish** — pixel-level click-through (your mouse passes straight through transparent areas), gaze tracking, drag/rotate/zoom, random idle motions; **per-part physics tuning**: hair, clothes, chest, and tail sway are each adjustable — that fluffy fox-tail bounce is something you dial in yourself. Idle throttling, battery/thermal downshifting, and full stop on screen lock keep it light as a background app.
- **Four UI languages** — Traditional Chinese / English / Japanese / Korean, following the system by default; the AI replies in the UI language too.

## Feature Overview

**The pet itself**
- Swap in any VRM model (tray menu / drag & drop onto the receiver window); multiple pets run simultaneously, each with independent settings
- Gaze follows the cursor; drag to move, right-drag to rotate, scroll to zoom; pixel-level click-through on transparent areas
- Lighting (directional/point light, shadows, color temperature 1800–12000 K), **per-part physics sway** (hair / clothes / chest / tail — independent spring-bone tuning), outfit visibility toggles
- VRMA motion playback, startup pose, idle motions (pick a set; plays randomly every 20–60 s)
- Power tiers: idle throttling + `powerMonitor` integration (battery/thermal downshift, full stop on lock/sleep, ProMotion displays clamped to the 60 Hz design rate)
- Pets can "rest" to release resources (WebGL context / caches / agent session) and wake on demand

**AI assistant (speech bubble)**
- Each pet binds to **Codex** (`codex app-server`, persistent JSON-RPC), **Claude Code** (CLI spawn), or **Antigravity** (`agy` CLI spawn; Gemini 3.x / Claude / GPT-OSS models; read-only / plan / full-auto modes, no ask-approval mode); dynamic model list, reasoning effort low–ultra, persona injected into the system prompt
- **Chat queue**: the input box never locks while a turn is running; messages queue up and continue automatically, each removable; ↑/↓ in the input box recalls sent messages (50 entries, IME-safe)
- Markdown-rendered replies (GFM, DOMPurify-sanitized), model/effort badge, an outside status capsule (working / awaiting approval / done — stays until read)
- **Image messages**: paste PNG/JPEG/WebP straight into the input (up to 4, 8 MiB each) for the AI to read
- **Drag-in reference files**: drag files/folders toward a pet and drop them on the receiver window that lights up — absolute paths are listed in the bubble and injected into the conversation
- **Bubble niceties**: pin to keep it open, drag the side edges to set width (double-click to reset), width adapts to content, and the cap tightens automatically when many pets are awake; a 📁 chip on the badge row switches the workspace in place; an assignment bar pins your request above the reply (tell pets apart when several run at once; shows "last time you said" after a restart)
- Persistent sessions (resume after app restart), interruptible turns, auto-reconnect after crashes, "+ New chat" to clear context
- **Pet tools (MCP)**: the agent can call `pet_play_motion` / `pet_show_expression` / `pet_speak` on its own — performing while it works

**Multi-pet collaboration (Control Panel)**
- Per-pet status list (resting / idle / working / awaiting approval), sorted by last activity
- Central dispatch: assign to a specific pet, or publish to the **shared task pool** (optionally restricted to a workspace) for idle pets to claim; a task ledger tracks the full queued→running→done lifecycle
- Approval proxy: answer approvals from the panel; the bubble and panel stay in sync
- Sandbox tab: per-pet Codex approval policy / sandbox mode / network access — written directly to the workspace's `.codex/config.toml` by the Electron main process, never by the AI
- UI language selector (zh-Hant / en / ja / ko)

**Safety by design**
- Three permission levels: read-only / workspace-write (approvals pop in the bubble) / full-auto; rejections can carry feedback for a same-turn course correction
- `workspace-write` still protects `.git` in most cases; commit/push requires explicit consent, or temporarily enabling full access (with double confirmation) in a trusted project
- New pets get their own working directory automatically (`~/Documents/PetWorkspaces/<pet-name>_<timestamp>/`) so they never contaminate other projects

## Requirements

- macOS (tested on Apple Silicon)
- Node.js 22+
- For AI features: [Codex CLI](https://github.com/openai/codex), [Claude Code](https://claude.com/claude-code), and/or [Antigravity](https://antigravity.google) (`agy` CLI) installed and logged in (subscription account) — any one of the three is enough

## Quick Start

```bash
npm install
npm run start   # detaches from the terminal; closing it (or ⌘Q on the IDE) won't take the pets with it
```

> For live logs during development use `npm run dev` instead — but that keeps the pet system attached to the terminal: closing it sends SIGHUP and kills the pets without the quit confirmation.

- Your character appears on the desktop; the window becomes interactive when the mouse is over the pet and click-through everywhere else.
- **Chat**: hover over the pet → type in the bubble → Enter to send (Shift+Enter for newline); keep typing while a turn runs and messages queue up.
- **Right-click the pet (or the tray icon)**: switch/add pets, choose a VRM file, motions, settings, **Control Panel**, sandbox settings, reset position, rest/wake, restart a pet or the whole system.
- **Settings panel** tabs: Lighting / Character (name, persona, sway, outfit) / Motion (default pose, idle motions) / Work (agent, model, effort, permissions, workspace).

Put models in `models/` and motions (.vrma) in `motions/`; runtime data lives in `runtime-data/` (all git-ignored).

> `.codex/config.toml` may contain project sandbox policy and local paths. Review before committing; credentials, tokens, and API keys must never enter the repository.

## Launch Parameters (Environment Variables)

Behavior can be tuned at launch via environment variables, e.g. `VRM_PET_DATA_DIR=/tmp/pets npm run dev`:

| Variable | Value | Effect |
|---|---|---|
| `VRM_PET_DATA_DIR` | path | Root directory for runtime data (`config.json`, `models/`, `motions/`, `runtime-data/` all live under it). Default: project root in dev, system `userData` when packaged. Point it at `$(mktemp -d)` for fully isolated test runs that never touch your daily pets' settings |
| `VRM_PET_AGENT_SELFTEST` | `1` \| `claude` \| `codex` \| `agy` | Headless regression self-test (no window, exits when done). `1` = MockProvider full-chain test, no quota; `claude`/`codex`/`agy` = e2e against the real CLI, **consumes subscription quota**, runs only when explicitly requested |
| `VRM_PET_AGENT_MOCK` | `1` | All pets use a fake agent (scripted events) while the full UI runs normally — verify the UI without spending quota |
| `VRM_PET_AGENT_DEBUG` | `1` | Dump agent child-process argv and payloads to the terminal, for debugging integrations |
| `VRM_PET_PERF_LOG` | `1` | Print the renderer's render/rAF ratio every 5 s (the overlay window can't open DevTools — this is the only perf channel) |

> `VRM_PET_PERM_SOCKET` / `VRM_PET_PERM_TOKEN` / `VRM_PET_TOOLS_SOCKET` / `VRM_PET_TOOLS_TOKEN` / `VRM_PET_PET_ID` / `VRM_PET_TURN_KEY` are internal channels the main process sets for agent child processes (approvals and MCP pet tools) — **do not set them manually**.

## Development & Verification

```bash
npm run typecheck && npm run build

VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev       # full-chain self-test with MockProvider
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=claude npm run dev  # real claude e2e (uses subscription quota)
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=codex npm run dev   # real codex e2e (uses subscription quota)
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=agy npm run dev     # real agy (Antigravity) e2e (uses quota)
VRM_PET_AGENT_MOCK=1 npm run dev                                          # fake agent through the UI, no quota
VRM_PET_AGENT_DEBUG=1 npm run dev                                         # dump agent argv/payload
VRM_PET_PERF_LOG=1 npm run dev                                            # perf metrics (the only channel — overlay has no DevTools)
```

Browser verification pages (with the dev server running): `/vrmtest.html` for rendering (`window.__viewer`), `/bubbletest.html` for the bubble (`window.__bubble`).

## Documentation

- [docs/DEVLOG.md](docs/DEVLOG.md) — development log: symptom → root cause → resolution for every issue (a trove of hard-won macOS overlay-window platform knowledge)
- [docs/AGENT-BRIDGE-DESIGN.md](docs/AGENT-BRIDGE-DESIGN.md) — agent bridge architecture (AgentProvider abstraction, approvals, queue, MCP pet tools)
- [docs/SYSTEM-INVENTORY.md](docs/SYSTEM-INVENTORY.md) — system inventory: capability list and data flow (IPC/event map; update it when you change interfaces)
- [docs/EXTRACT-GUIDE.md](docs/EXTRACT-GUIDE.md) — Unity game → VRM/VRMA extraction guide (model/motion/pose conversion pipeline, personal use only; guide text in Traditional Chinese)
- [CLAUDE.md](CLAUDE.md) — development rules (rendering follows the official three-vrm examples line by line; no homegrown architecture)

## License

Code is under the [MIT License](LICENSE). The sample VRM model (`AvatarSample_A`) is the official VRoid sample, used under its original license; models and motion files you add yourself follow their respective authors' licenses.
