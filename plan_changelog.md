# Implementation Plan Changelog

This file is a historical record of approved changes. It does not override [`implementation_plan.md`](./implementation_plan.md), which contains the authoritative current specification and checklist.

## Stage 14 README expansion

Approved README work documents checkout loading, live file/Bash review, commands and defaults, configuration semantics/reference, branch-sensitive workspaces, trusted resources, non-UI behavior, waiting editors, and concrete best-effort recovery risks. Replace obsolete not-live-connected wording. Distinguish the historical compatibility baseline from current dependency/user verification observations without asserting open-ended support or changing package metadata. Published-package installation, compatibility reconciliation, and final release approval remain outstanding.

## Stage 13 approval with explicit verification deferrals

The user approved moving to Stage 14 after confirming full automated verification and completing the recorded manual subset. Remaining manual recovery, editor, hook, non-UI, and platform checks are deferred to daily use, not recorded as passed. Repeated clean-checkout provenance and exact versions remain unrecorded. Preserve outstanding evidence items and distinguish Stage 13 acceptance from final release approval. `stage13_verification.md` records the evidence, deferrals, and acknowledged best-effort recovery risks.

## Bash acceptance with unconfirmed editor termination

Approved during the Stage 13 cancellation audit. Consume the coordinator's external-cancellation outcome before allowing a prompt-accepted Bash command. Unconfirmed or failed termination blocks execution with a clear editor-termination diagnostic, without approval feedback or edited-command authorization. Retain best-effort artifact cleanup. Focused workflow regressions cover both termination outcomes and exactly-once termination/cleanup; confirmed cancellation and already-completed editor behavior remain unchanged.

## New-preview parent validation before cleanup

Approved during the Stage 13 recovery audit. Validate initially missing parent paths shallow-to-deep against captured identities before target deletion or directory cleanup. An unsafe or untracked existing parent stops all destructive cleanup and reports the first offending parent; missing paths remain compatible with idempotence. Retain immediate cleanup identity checks and deepest-first non-recursive directory removal. Regressions cover outer/inner symlinks to moved preview directories, repeated restoration, and parents created after state capture. This detects preexisting replacements without adding locking or claiming protection against later filesystem races.

## Existing-preview restoration path identity

Approved during the Stage 13 recovery audit. Check existing targets with `lstat()` before opening for restoration, rejecting non-regular or identity-changed paths while retaining handle-level verification and error/closure precedence. A symlink to the moved original must not bypass replacement detection merely because the opened handle has the snapshot's inode. Add a real temporary-root regression verifying that the link and moved proposal remain untouched on repeated restoration. Check/open races remain a best-effort limitation; no locking or sandbox guarantee is added.

## Configuration-warning fallback isolation

Approved during the Stage 13 configuration audit. Contain throwing configuration-warning callbacks with `attempt.sync()` in both read-error and invalid-source fallback paths. Continue returning empty configuration and attempting the current warning on every load without historical suppression. Focused regressions cover read failures, malformed TOML, schema errors, and invalid regexes with throwing reporters.

## Best-effort workspace-opener completion and warnings

Approved during the Stage 13 codebase audit. Observe opener completion through `attempt()` while preserving non-blocking launch. Completion rejection produces a best-effort diagnostic, warning callbacks are contained across resolution/startup/completion paths, and warnings are suppressed after shutdown. Focused regressions cover rejected observers, throwing reporters, late completion after shutdown, and group continuation without unhandled rejections.

## Stale workspace mutation cancellation

Approved during the Stage 13 codebase audit. Add/remove commands use a runtime-only revision captured before asynchronous preparation and checked before confirmation/persistence. Restoration and successful mutations advance the revision, including restoration of an identical list. Discard stale or shutdown-interrupted commands without committing or reloading; advise retry on stale state while UI is available and stop silently on shutdown. Fake-API wiring verifies defensive branch/concurrent-mutation orderings rather than claiming ordinary Pi UI permits them. No locks or persistent recovery machinery.

## Workspace-opener shutdown guards

Approved during the Stage 13 codebase audit. Workspace opening checks runtime shutdown before handler resolution and immediately before spawning. Both opener commands guard admission and asynchronous lookup/selection boundaries, then pass the runtime shutdown check into each opener. The leaf is verified before command integration; paused-configuration wiring regressions cover single/group late launches and post-shutdown admission, plus selection returning after shutdown.

## Public feature-index boundaries

Approved during the Stage 13 codebase audit to align production imports with the working agreement. Add the file-review public index and route existing cross-feature operations, types, and message contracts through owning feature indexes. Expose only symbols already required by implemented consumers; retain focused internal utility specs' permitted direct imports. No behavioral changes or speculative exports.

## File-preview and application error precedence

Approved during the Stage 13 codebase audit. Snapshot capture, existing-file restoration, and reviewed-content application use the verified `attemptWithCleanup()` boundary to always attempt closure without masking the primary operation's exact error. Successful operations with failed closure report the close error. Identity checks, restoration ordering, and owned-temporary-file removal remain unchanged. The dependency leaf is verified separately before integrating these consumers.

## Reject special preview targets before opening

Approved during the Stage 13 codebase audit. Existing-target snapshot capture checks for a regular file before opening, preventing a FIFO without a writer from indefinitely blocking review and shutdown. Retain the handle-level check; do not claim elimination of the check/open TOCTOU race. A real FIFO regression uses a dedicated OS-temporary fixture and a timeout-bounded child process on non-Windows platforms.

## Config-save temporary-file ownership

Approved during the Stage 13 codebase audit. Atomic configuration saving establishes temporary-file ownership through exclusive opening before any cleanup path. Creation collisions preserve the preexisting file; write, close, or rename failure triggers only owned-file removal and retains the original error. Real OS-temporary fixtures cover collision preservation and cleanup after write and rename failures.

## Temporary-file write and close error precedence

Approved during the Stage 13 codebase audit. Attempt temporary-file writes and handle closure independently so closure always runs without replacing the original write error. A successful write followed by failed closure reports the close error. Either failure triggers best-effort removal of the exclusively owned artifact. Focused regressions use real temporary files with injected write/close failures and verify exact error identity.

## Config-editor shutdown boundaries

Approved during the Stage 13 codebase audit. Config editing checks runtime shutdown before preparation and after asynchronous preparation, handler resolution, external completion, fallback-source reading, and Pi editing. A typed shutdown outcome prevents late editor launches, shutdown-triggered fallback, late Pi-editor saves, and new revalidation/completion notifications. Already-started filesystem writes and editor side effects are not transactional or rolled back.

## Hook dispatch cancellation after configuration loading

Approved during the Stage 13 codebase audit. Hook dispatch rechecks runtime shutdown before launching each command, including after asynchronous configuration resolution. Review permission hooks also recheck their prompt signal so an editor-first outcome or cancellation cannot announce a stale prompt. This prevents commands starting after shutdown's process-cleanup pass without introducing persistent hook tracking or changing declaration-order and failure-isolation semantics.

## Literal workspace roots and native read fallback permissions

Approved during the Stage 13 codebase audit. Canonicalize already-resolved workspace roots without applying Pi tool-input transformations, preserving literal Unicode spaces and preventing similarly named siblings from inheriting permission. For native `read`, check the actual Pi-compatible fallback candidate's canonical target before granting workspace permission, including fallback symlinks. Keep original tool arguments unchanged, avoid private Pi imports, and verify compatibility against actual native read execution. Existing filesystem TOCTOU limitations remain.

## Editor-authorized Bash replacement

Reopened Stage 9 after its original manual verification. Saving and closing a configured waiting editor now authorizes its changed, non-empty command to replace the current Pi Bash execution input without an additional confirmation or agent round-trip. Empty changes and unsuccessful editor results never execute. Pi's assistant tool-call entry retains the original proposal, so the tool result must identify the exact command Pi received for execution for both user and agent, without claiming success if execution failed. No separate user notification is required. This supersedes the earlier suggestion-only contract below, which remains recorded as historical context.

## Assistant-message hook tool summaries

Refined `assistant_message_text` to prepend a short `Tool "<name>" is being called.` line for each tool call before any assistant descriptions. Tool arguments and thinking remain excluded. Empty or whitespace-only combined messages do not dispatch `assistant_message_end` hooks. This keeps tool-only notifications useful without adding aggregation across messages or changing the settled event.

## Additive hook execution

Separated handler and hook rule-selection semantics. Handlers retain last-match-wins because each workflow requires one selected policy or command. Hooks now execute every matching command in declaration order because they represent independent event side effects. Each matching hook command is dispatched independently; a startup or completion failure does not suppress later matches or affect Pi's underlying flow. Empty hook arrays and events with no matches remain no-ops.

## Review coordinator and process-adapter ownership

Clarified the Stage 8/Stage 9 boundary. The review coordinator owns generic prompt/external-source races, caller cancellation, idempotent external-operation cleanup, truthful unconfirmed cancellation outcomes, and late-callback handling without importing process types. External Bash Review owns the first tracked `ProcessRunner` adapter, translation of process completion and termination into generic coordinator outcomes, and runtime-shutdown process cleanup. Later file review reuses that adapter boundary rather than coupling the coordinator to child processes.

## Complete edited Bash suggestions

Removed the planned bounded/truncated command suggestion. A changed external command still blocks the original and is never executed automatically, but the agent-facing block reason now contains the complete edited command, including empty content. The editor is explicitly user-controlled, and preserving the exact reviewed command was judged safer and more useful than presenting a potentially executable but incomplete prefix. No persistent temporary artifact or diff protocol is introduced.

## Interactive permission-hook timing

Narrowed `tool_permission_request` semantics to actual interactive Pi permission prompts. The hook fires immediately before a workspace-permission or review Accept/Reject prompt can be displayed. It does not fire for explicit `allow`/`deny`, normal no-op behavior, unavailable non-UI prompts, or external-editor-only review. External review emits the hook only when UI is available and the coordinator also presents Pi's Accept/Reject prompt.

## Integrated delivery checkpoints

Refined the consolidation after a full-document review: linked dependency order to the fourteen feature-local checkpoints, explained composition boundaries, and separated implementation from verification evidence where they had become interleaved historical additions. Preserved completed/open status and all review gates. Replaced the obsolete suggested directory tree with feature ownership and corrected residual warning, primary-workspace, prompt-outcome, and feedback-settlement contradictions to match previously approved behavior. The plan now distinguishes product contracts, completion evidence, and collaboration rules rather than maintaining parallel task and phase lists. A second end-to-end verification pass corrected remaining scope, sequencing, cancellation, config-editor, workspace-resource, testing, roadmap, and acceptance terminology; it also aligned the working agreement with embedded delivery stages and feature-level test grouping.

## Artifact-dependent review-policy resolution

Clarified the Stage 7 composition boundary: handler categories are resolved only after their owning workflow has constructed every real declared variable. Stage 7 owns reusable policy/default evaluation, prompt feedback, post-tool actions, and reservation lifecycle; the later Bash and file workflows own secure command-file and preview/snapshot artifacts and then feed their resolved actions through that boundary. Placeholder artifact paths and partial rule evaluation are explicitly prohibited.

## 2026-09-15 — Initial plan consolidation

The following previously approved changes were incorporated into the authoritative implementation plan:

- **Configuration warning deduplication:** Removed. Every configuration load reports its current read or validation warnings. The warning callback has no replaceable-diagnostics capability, and avoiding stateful historical suppression ensures current errors remain visible.
- **Configuration hooks and actions:** Replaced the `handlers.notifier` category and per-rule `event`/`handler` fields with command-only `hooks.<event>` arrays and a shared `action` field. `handlers.*` and `hooks.*` now share ordered conditions, placeholder, and last-match-wins semantics. Handler actions may be decisions or commands where allowed; hook actions are commands only. Initial hook-specific variables are `assistant_message_text` for `assistant_message_end`, `tool_name` for `tool_permission_request`, and none for `agent_settled`.
- **Config editor execution and fallback:** Removed shell-command execution, the one-off `/tc:edit-config` override, `$VISUAL`/`$EDITOR` handling, and the `vi` fallback from the initial release. `/tc:edit-config` accepts no arguments. It launches a matching direct-argv `handlers.configuration_editor` action when configured; otherwise, it opens the current config source in Pi's multiline editor when UI is available. Pi-editor cancellation preserves the existing file, while returned text (including empty text) is written atomically. Without UI or a configured action, it exits without editing because Pi provides no UI reporting channel in that mode. Cross-platform shell parsing and platform-specific editor fallbacks may be designed later.
- **Config editor failure recovery:** A configured external editor's spawn failure, nonzero exit, or signal termination triggers automatic Pi multiline-editor fallback when UI is available; a clean exit does not. Report the failure first, then reread the current configuration file before opening Pi's editor, since the external editor may have changed it before failing. Save returned text (including empty text) atomically or preserve the current file on cancellation, then revalidate. Without UI, retain the existing non-interactive configured-editor failure outcome and revalidation without opening an editor. Implement and verify this follow-up before closing Section 3.
- **Primary and additional workspaces:** Treat Pi's session cwd as the primary workspace and automatically path-permit it. Pi's current `ctx.cwd` is the source of truth for the primary workspace: derive its canonical path whenever an operation needs it rather than caching or persisting it. The extension owns only the additional-workspace list, which is the only workspace state retained and persisted. `WorkspaceState` may combine the freshly derived primary path and managed additional list as a temporary operation input; retain only the updated additional list afterward. Commands and UI distinguish the primary workspace from additional workspaces. An empty additional list therefore permits only the primary workspace. Pi remains responsible for native primary-workspace resource and instruction discovery. For additional workspaces, replace the planned `.pi/AGENTS.md` convention with Pi-compatible root precedence: `AGENTS.override.md`, otherwise `AGENTS.md`, otherwise `CLAUDE.md`. Also append `<workspace>/.pi/APPEND_SYSTEM.md`, but never load `.pi/SYSTEM.md`. Reread selected files before every agent run and attribute their workspace and path. Users should launch Pi from the project they want as primary rather than from home.
- **Workspace symlink semantics:** Canonicalize a workspace directory with `realpath()` when it is added, persist the target path rather than the supplied alias, and use that canonical identity for exact duplicate detection and later workspace boundaries. Removal remains an exact stored-path state operation with no filesystem dereference, so deleted or inaccessible targets remain removable through their listed path or selector. Follow symlinked skill directories, prompt directories, root instruction files, and `.pi/APPEND_SYSTEM.md` transparently, including deliberate links to shared content outside the workspace; do not impose containment on these user-selected resources. Pi may canonicalize discovered skill files itself to avoid loading the same physical skill more than once through different aliases.
- **Workspace snapshot shape:** Persist full snapshots as `{ additionalWorkspaces: string[] }`, matching the existing state terminology. Do not include a version field or persist the primary workspace. This replaces the planned `{ version: 1, paths: string[] }` format; active-branch restoration still selects the nearest valid snapshot and honors an empty additional-workspace list.
- **Workspace command confirmation and diagnostics:** Before an effective workspace addition or removal, require UI confirmation that identifies the canonical or stored path and explains that Pi will reload. Declining or cancelling leaves state unchanged; without UI, these state mutations do not proceed. Invalid, duplicate, primary-removal, and not-found outcomes are reported before confirmation where applicable. After confirmation, persist the full snapshot and reload without a transient success notification that reload could immediately clear. If the primary workspace path becomes unavailable, warn with the underlying failure, retain the raw `ctx.cwd` only for display, and continue useful list/group-open behavior with stored additional workspaces. `/tc:workspaces-open` explicitly warns that it does not accept arguments rather than presenting generic usage text.
- **Extension storage paths:** Store persistent configuration at `<effective PI_CODING_AGENT_DIR>/teleprompt-commentary/config.toml`, where Pi's agent directory defaults to `~/.pi/agent` but respects `PI_CODING_AGENT_DIR`. Keep ephemeral review artifacts outside configuration under one securely created, uniquely named Teleprompt Commentary runtime directory within the operating system's temporary directory, with tracked shutdown cleanup.
- **Best-effort review lifecycle and reload recovery:** Keep reservations, active reviews, tracked processes, and deferred post-tool actions local to the current extension runtime. Do not add durable transaction journals, reload-persistent global registries, cross-runtime ownership transfer, or OS-level locking initially. Isolate temporary preview mutation and process ownership within local operations, use direct `try`/`finally` cleanup, and restore previewed filesystem state before returning from `tool_call` whenever practical. A reload during an active tool call may lose reservation coordination, process tracking, deferred reviewed content, or feedback; path checks also remain subject to filesystem TOCTOU races, and detached or crashed editors may defeat cleanup. Treat these as documented best-effort limitations rather than attempting sandbox or transactional guarantees. Preserve normal Pi behavior where possible, recommend normal version-control safeguards and user recovery, and add complexity only when observed failures make it necessary.
- **New-file preview directory restoration:** When a proposed new target has missing parent directories, the pre-review snapshot records its nearest existing ancestor and every intermediate directory that was absent before preview. Restoration removes the preview target, then attempts to remove only those initially missing directories in deepest-first order using non-recursive empty-directory removal. Never recursively delete an intermediate directory, never remove a directory that existed before preview, and leave a directory intact if it is nonempty, replaced, or otherwise cannot be safely removed. This cleanup is best-effort and remains subject to the documented filesystem TOCTOU limitation.
