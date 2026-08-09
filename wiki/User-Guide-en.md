# User guide

## Managing multiple pets

Use the Tray or pet context menu to add, switch, rest, wake, or restart pets. Pets assigned to the same workspace are grouped together, and the speech bubble displays the final folder name of the project root.

Resting releases WebGL resources, caches, and the live agent runtime while retaining persistent settings. You can restart only the current pet or restart the complete system through the local PID script.

## Working with the AI assistant

- Messages entered while a task is running are queued automatically.
- Paste up to four PNG, JPEG, or WebP images, each up to 8 MiB.
- Responses render sanitized Markdown.
- **New conversation** clears the session context for the next message.
- **Stop** interrupts the current task.

## Permissions and approvals

| Level | Recommended use |
|---|---|
| Read-only | Questions, analysis, and inspection |
| Write with approval | Normal development; risky actions require confirmation |
| Automatic | Trusted workspaces and controlled automation |

When declining an operation, enter the adjustment you want. Claude receives it as the denial message; Codex steers the same turn with the feedback. Sandbox settings are written directly by the Electron main process to `.codex/config.toml`, never delegated to the AI.

## Reference-file drop

Drag a file or directory toward a pet. Because the special macOS transparent overlay cannot receive native drop events, 3D-pet shows a regular translucent receiver over the character.

- Files and directories become conversation references.
- `.vrm` replaces the character model.
- `.vrma` plays a motion.

## Control center

The control center provides:

- A status list for every pet: resting, idle, working, or awaiting approval.
- Direct assignment to one pet.
- A shared task pool that idle pets can claim.
- Central approval handling.
- Per-pet Codex sandbox settings and UI language selection.

## Appearance and power management

Tune directional or point lighting, shadows, and spring-bone strength for hair, clothes, chest, and tail. Configure a startup pose and randomized idle motions. Rendering is throttled while idle, reduced on battery or thermal pressure, and suspended during lock or sleep.

## Troubleshooting

### The bubble never closes

Check the pin. An unpinned bubble closes after the pointer leaves, even while an agent is working.

### The desktop appears frozen after an approval

The current version releases input focus before hiding the approval UI. If the issue persists, restart the current pet and inspect the terminal agent log.

### System restart fails

Inspect `runtime-data/pet-system-restart.log`. The local script reads `runtime-data/pet-system.pid`, terminates that process, and runs `npm run dev` again.
