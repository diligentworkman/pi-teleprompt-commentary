# Pi Teleprompt Commentary

A **Pi-only permission and review aid** for agent tool calls, with explicit session workspaces and optional external-editor review. It is **not a security sandbox**.

## Load from a checkout

Install dependencies from this checkout:

```sh
pnpm install --frozen-lockfile
```

Then launch Pi from the project you want as your **primary workspace**, loading this extension by its absolute checkout path:

```sh
extension_root="/absolute/path/to/pi-telepromt-commentary"
cd /absolute/path/to/your/project
"$extension_root/node_modules/.bin/pi" -e "$extension_root"
```

The primary workspace is Pi's current working directory. Pi owns its native resource and instruction loading; this extension adds resources only for explicitly added workspaces.

## Compatibility

Development uses Node.js 24 and pnpm 11; this checkout currently resolves Pi 1.0.2. Compatibility with other versions is not guaranteed. Windows path/symlink behavior has not been verified.

Compatibility relies on Pi's public extension hooks, namespaced commands, branch-aware session access, resource discovery, and public local `write`/`edit` definitions. Recheck these assumptions and hook ordering before changing the Pi baseline.

## Defaults and permission boundaries

With no matching configuration rule:

- `write` and `edit` require Pi's Accept/Reject review, with optional feedback.
- Agent `bash` keeps normal Pi behavior.
- `read`, `grep`, `find`, and `ls` inside permitted workspaces keep normal behavior.
- Supported path tools outside all workspaces require permission for that call. Approval does not permanently add the directory; file-change review still follows when applicable.

The primary workspace is automatically permitted. Additional workspaces are canonical directories explicitly added to the session. Symlink targets are considered during path authorization; similar-looking sibling names do not inherit permission. Same-path file mutations are reserved while review/execution is pending; a conflicting call is blocked rather than silently queued.

**Bash, custom tools, external programs, and filesystem races can bypass these boundaries.** User `!`/`!!` shell commands are not intercepted. Do not treat workspace permission as containment of arbitrary code.

## Commands

- `/tc:edit-config` — create the commented starter if absent, then open the configured configuration editor or Pi's fallback editor. Takes no arguments.
- `/tc:workspace-add [directory]` — supply a directory or use the input prompt. Effective additions require confirmation, persist a session snapshot, and reload resources. Exact canonical duplicates and the primary workspace are not added.
- `/tc:workspace-remove [stored-directory]` — supply the exact stored path or select an entry. Confirm removal and reload. The primary workspace cannot be removed; deleted or inaccessible additional entries remain removable.
- `/tc:workspace-list` — list primary and ordered additional workspaces separately.
- `/tc:workspace-open [directory]` — open a permitted session workspace using the configured opener, or select one interactively.
- `/tc:workspaces-open` — open available session workspaces as a best-effort group. One group ID is shared across that invocation; takes no arguments.

Workspace membership is stored as session entries and restored from the nearest valid snapshot on the active branch, including an empty list. Resume and tree navigation preserve branch-local membership. Overlapping directories remain distinct; no automatic root inference or overlap collapsing occurs. Pending add/remove changes are discarded if workspace state changes while they wait.

Pi may prefix command descriptions with source markers such as `[t]` for CLI-loaded extensions. These markers come from Pi, not the command descriptions.

## Configuration

The optional global TOML file is:

```text
<effective PI_CODING_AGENT_DIR>/teleprompt-commentary/config.toml
```

The default agent directory is `~/.pi/agent`. There is no workspace-local extension configuration.

Run `/tc:edit-config` to generate the **fully commented TOML reference**, which is the complete configuration reference. Examples are inactive until uncommented; this README intentionally does not duplicate the full schema.

High-level semantics:

- Configuration is checked at startup and reread for affected actions. Missing configuration silently uses defaults; invalid configuration reports current warnings and falls back to empty configuration/default policies.
- Handler rules use JavaScript regular-expression conditions, not globs. Every condition must match; the **last matching handler rule wins**.
- `diff_editor` applies to existing files; `new_file_editor` applies to new files. They do not fall back to each other. `command_editor` matches the raw agent Bash command.
- Review handlers accept `allow`, `deny`, `prompt`, or a direct command array. Configuration editors, workspace openers, and hooks accept commands only.
- Command placeholders expand to exactly one argv element, including spaces and optional prefix/suffix text. Commands launch directly with `shell: false`; shell behavior requires an explicitly configured shell executable.
- Hook rules are additive: every matching command starts in declaration order, independently of failures. Supported hooks are `assistant_message_end`, `tool_permission_request`, and `agent_settled`.
- Permission hooks run only before a live interactive permission/review prompt, not for explicit allow/deny or unavailable prompts. Assistant-message hooks receive tool-name summaries and text, not tool arguments or thinking.

A clean configuration-editor exit finishes normally. With UI, an unsuccessful configured editor triggers a warning, rereads its actual filesystem effects, and opens Pi's fallback editor. Cancelling that fallback preserves the current file; saving accepts even intentionally empty text. Without UI, there is no fallback editor.

## Additional-workspace resources and trust

Adding a workspace is also a decision to trust its contributed instructions and resources:

- Skills: `.pi/skills` and `.agents/skills`.
- Prompt templates: `.pi/prompts`.
- Root instructions: the first available `AGENTS.override.md`, otherwise `AGENTS.md`, otherwise `CLAUDE.md`.
- Additional system text: `.pi/APPEND_SYSTEM.md`.

Selected instruction sources are reread before agent runs and appended with workspace/path attribution. Deliberate resource symlinks are followed, even outside the selected root; resource trust is not the same boundary as tool-path permission.

The extension does not load additional-workspace extensions, themes, `.pi/SYSTEM.md`, workspace-local extension config, or recursive instruction trees. Pi continues to own primary-workspace resources and instructions.

## External-editor review

Use a **waiting editor command**, such as an appropriate `--wait` invocation. Opening a GUI and immediately exiting its launcher is not reliable review completion.

### Files

For a configured external file handler:

1. Snapshot original state and run Pi's real local built-in `write`/`edit` definition to put the proposal on the **actual target**.
2. Open the editor on that target; existing-file review also receives a temporary original-content reference.
3. With UI, race the editor against Pi's Accept/Reject prompt. Without UI, the editor is the sole decision source.
4. Restore original state before allowing the normal Pi tool execution.
5. If the editor successfully changed the content, apply the captured reviewed bytes after normal execution and annotate the tool result.

A clean unchanged editor exit accepts the original proposal. A clean changed exit authorizes the edited contents, including an intentionally empty file. Prompt acceptance instead discards editor changes and accepts the original tool; rejection blocks. Editor failure leaves a UI prompt viable, but blocks when there is no UI. Unconfirmed editor termination or restoration prevents normal file execution.

Reviewed-content application is attempted even if the normal Pi tool fails. The original result/error state remains visible, with a concise application-success/failure annotation. Pi may queue ordinary messages while review holds the tool call pending; queued messages are not review decisions.

Preview assumes local native text tools, no replacement of their behavior by another extension, no remote redirection, and the same filesystem for preview and execution. Snapshot bytes do not add binary-editing support. The built-in tool runs once for preview and again for normal execution.

### Bash

A configured command editor receives a temporary file containing the raw command. Saving and closing successfully authorizes its exact nonempty edited text for the current Bash call. Empty edits block. The tool result records the executed command because Pi's original assistant proposal can differ from execution input.

Prompt acceptance keeps the original command; it blocks if cancellation of the losing editor is unconfirmed or fails. Optional acceptance feedback appears once in the tool result; rejection feedback appears in the block reason.

### Non-interactive use

Prompt-required review and outside-workspace permission fail closed without UI. Explicit allow rules and successful configured external reviews can proceed without a Pi prompt. External review failure cannot rely on a UI fallback in non-interactive sessions.

## Recovery and troubleshooting

**Restoration is best-effort, not a transaction, lock, sandbox, or durable recovery system. Back up important uncommitted work before external file review.**

- **Real-file side effects:** watchers, build systems, and other processes can observe the temporary proposal. Restoring bytes does not undo those effects.
- **Crash or forced termination:** cleanup may not run, leaving proposal content or artifacts behind. There is no durable recovery journal.
- **File or parent replacement:** detected identity changes are preserved rather than overwritten/deleted. Atomic editor saves can therefore block restoration. Inspect the actual reviewed target and decide whether to keep it or recover its pre-review content from an independent backup/version control.
- **No durable original backup:** temporary original-content references may be removed even when restoration fails. Do not rely on them to recover uncommitted work.
- **New directories:** only originally absent, identity-checked empty parents are removed, non-recursively. Unsafe/replaced parents stop destructive cleanup; unrelated content is preserved and incomplete cleanup is reported.
- **Filesystem races:** identity checks do not prevent every change between checks and operations, preview and identity capture, or preview and normal execution.
- **Detached editors:** terminating a CLI does not guarantee its GUI closes. Close stale tabs without saving them over newer work.
- **Final application failure:** permissions, missing parents, or disk errors can prevent reviewed bytes from being applied. Inspect the target; it may contain normal tool output rather than the reviewed version.
- **Reload/shutdown:** orderly shutdown aborts tracked reviews, attempts process cleanup/restoration, and cleans owned runtime artifacts. Mid-tool-call reload and abrupt termination remain best-effort; they are not rollback guarantees.
- **Unexpected prompts:** confirm the target belongs to the active branch's workspace list and that the last matching configuration rule is the intended one.
- **No opener/editor:** define the appropriate command handler in the generated TOML and check the executable and waiting flags. Workspace opening requires a configured opener.

Do not blindly restore a Git version if that would discard valuable pre-review uncommitted changes. Inspect the target and recover deliberately.

## Development

```sh
pnpm run typecheck
pnpm test
pnpm run verify
```

Source lives in `extensions/src/`, organized into feature modules. `extensions/src/index.ts` composes their public APIs into Pi lifecycle handlers. Tests live in `extensions/tests/unit/` and `extensions/tests/wiring/`.

Automated tests use focused modules, fake extension APIs, and real public native tools—not recreated model inference or agent loops. Add focused regression coverage when changing behavior; check real interactive lifecycle behavior manually in Pi.

For disposable manual fixtures, run `bash manual-test.sh`. It opens a temporary workspace and provides a `pi-tc` launcher that loads this checkout. Keep test files and symlink targets beneath `PI_TELEPROMPT_TEST_ROOT`; exiting the shell deletes that root. Use an isolated `PI_CODING_AGENT_DIR` beneath it if testing configuration changes without affecting your normal profile.
