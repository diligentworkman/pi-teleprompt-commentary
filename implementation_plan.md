# Pi Teleprompt Commentary — Implementation Plan

This file is the authoritative current product, architecture, and implementation plan. [`plan_changelog.md`](./plan_changelog.md) records history, not overriding requirements; [`working_agreement.md`](./working_agreement.md) governs collaboration and engineering conventions.

Read the behavior beside each feature's delivery checklist: prose defines its contract, checkboxes track implementation and evidence, and the checkpoint approves the composed result. A checked leaf does not imply completed lifecycle wiring. Section 10 links these checkpoints in dependency order; it does not maintain separate completion state.

## 1. Purpose and Scope

Pi Teleprompt Commentary is a **Pi-only extension** with three responsibilities:

1. **Review agent tool calls**
   - Intercept Pi's built-in path tools and agent `bash` calls at `tool_call` preflight.
   - Resolve user-defined policies that allow, deny, prompt, or launch an external review command.
   - Let users revise proposed file contents or replace an agent shell command through an explicitly configured waiting editor.

2. **Attach multiple workspaces to one Pi session**
   - Maintain an explicit, session-scoped list of workspace directories.
   - Tell the agent which workspaces belong to the session.
   - Gate predictable path tools when they access paths outside those workspaces.
   - Let Pi own primary-workspace resources and add supported resources/instructions from each additional workspace.

3. **Run external handlers**
   - Open files, diffs, workspaces, and the extension config.
   - Send best-effort desktop notifications.

This extension is a **permission and review aid, not a security sandbox**. `bash`, custom tools, symlink races, and external programs can bypass its path checks. The initial implementation supports Pi only; it will not include abstractions for OpenClaw or other agent harnesses.

---

## 2. Settled Product Behavior

### 2.1 Global configuration

The extension has one optional global TOML file:

```text
<effective PI_CODING_AGENT_DIR>/teleprompt-commentary/config.toml
```

The effective Pi agent directory defaults to `~/.pi/agent` and respects `PI_CODING_AGENT_DIR`. There are no workspace-local extension configs and no JSON config format.

Config loading behavior:

- Missing config means built-in defaults and no warning.
- Parse and validate once during `session_start` so users see errors early.
- Reread and validate on every affected action so edits take effect without `/reload`.
- Invalid TOML, invalid regexes, and schema errors produce non-blocking warnings and safe fallback behavior.
- Report current warnings on every configuration load; do not retain historical warning-deduplication state. Warning reporting is best-effort: a throwing reporter must not prevent empty-configuration fallback after read, parsing, or validation failures.
- Generate a fully commented starter config from `/tc:edit-config` when the file does not exist.
- The generated TOML, not README, is the complete configuration reference.

### 2.2 Review actions and defaults

File and command review rules may resolve to:

- `"allow"`: proceed without extension review;
- `"deny"`: block immediately;
- `"prompt"`: use Pi's Accept/Reject prompt with optional feedback;
- a command array: launch an external handler and, when Pi has UI, race it against the Pi prompt.

Defaults when no rule matches:

| Tool or situation                               | Default                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `write`                                         | `prompt`                                                      |
| `edit`                                          | `prompt`                                                      |
| `bash`                                          | normal Pi behavior                                            |
| `read`, `grep`, `find`, `ls` inside a workspace | normal Pi behavior                                            |
| Supported path tool outside all workspaces      | one-call workspace permission prompt, then normal policy flow |

Emit `tool_permission_request` only immediately before Pi displays an interactive permission prompt. Explicit `allow`/`deny`, no-op behavior, unavailable non-UI prompts, and external-editor-only review do not emit it. An external review emits it only when UI is available and the coordinator also displays Pi's Accept/Reject prompt.

### 2.3 Existing and new files

- `diff_editor` applies only when a proposed operation targets an existing file.
- `new_file_editor` applies only when a proposed operation targets a new file.
- They are mutually exclusive and do not fall back to one another.
- `edit` normally uses `diff_editor` because Pi's built-in edit requires an existing file.
- `write` chooses based on existence when preflight starts.

### 2.4 External file review

For a matching external file handler:

1. Complete workspace authorization and canonical target resolution.
2. Reserve the canonical target path for this tool call.
3. Snapshot the pre-review filesystem state.
4. Invoke Pi's actual built-in `write` or `edit` tool definition with the original arguments. This writes Pi's exact proposal to the actual target.
5. For an existing file, pass a temporary original-content file and the actual proposed target to `diff_editor`.
6. For a new file, pass the actual proposed target to `new_file_editor`.
7. If Pi has UI, launch the external editor and Pi prompt concurrently. Otherwise, use the configured external editor as the only decision source.
8. Capture the decision or user-reviewed contents.
9. Restore the pre-review filesystem state before the original Pi tool call proceeds.
10. Let Pi run the original tool normally.
11. Apply any captured reviewed contents afterward in `tool_result` and annotate the result concisely.

Outcomes with Pi UI:

- **Pi accepts first:** cancel and await the editor, ignore late outcomes, discard unconfirmed editor changes, restore, and allow the original tool. Preserve optional acceptance feedback for the tool result.
- **Pi rejects first:** cancel and await the editor, ignore late outcomes, restore, and block with optional feedback.
- **Editor exits successfully unchanged:** abort the prompt, restore, and allow the original tool.
- **Editor exits successfully changed:** abort the prompt, capture reviewed contents, restore, and allow the original tool. Reapply reviewed contents after Pi's tool finishes.
- **Editor fails to start or exits unsuccessfully:** warn and leave the Pi prompt active.

Outcomes without Pi UI:

- unchanged successful editor exit means accept;
- changed successful editor exit means capture and later apply reviewed contents;
- editor startup/nonzero failure means block because no prompt can take over.

Compare contents byte-for-byte. Empty content is a valid intentional revision.

If Pi's normal tool execution fails, still attempt the deferred reviewed-content application. Preserve Pi's original `isError` state and original result content, then append whether the deferred application succeeded.

The preview executes Pi's built-in tool once and the normal call executes it again. Document these assumptions and limitations:

- `write`/`edit` are Pi's local built-in implementations;
- another extension has not replaced their behavior;
- operations are not redirected to SSH, a container, or another remote backend;
- the same local filesystem is used for preview and normal execution;
- external filesystem changes between the two executions can change the result.

Where an override is clearly detectable, warn or fall back to a plain prompt. Do not build elaborate backend detection in the initial release.

### 2.5 Bash review

- Match `command_editor` conditions against the raw agent command.
- Do not workspace-gate `bash`.
- Do not intercept user `!` or `!!` commands.
- For an external handler, write the raw command to a secure temporary file.
- Unchanged successful editor exit accepts the original command.
- Prompt acceptance accepts the original command and discards editor changes; optional feedback is delivered with the tool result.
- Prompt rejection blocks with optional feedback.
- Saving and closing a configured editor authorizes its changed, non-empty command. Mutate the current Pi Bash tool input to the exact edited text so Pi executes it normally, without another confirmation or agent round-trip.
- Empty edited content blocks execution. An editor failure never authorizes changed content.
- Pi's assistant tool-call record retains the original proposal even when its execution input is mutated. Append a tool-result annotation with the exact command Pi received for execution so the user and agent can distinguish proposal from execution, even if the Bash tool itself fails; do not send a separate notification.

### 2.6 Prompt feedback

The review prompt is two-step:

1. Choose `Accept` or `Reject`.
2. Enter optional feedback for either decision.

The decision operation returns `accepted`, `rejected`, `dismissed`, `superseded`, or `unavailable`. Feedback is a separate operation, not part of settling the decision race.

- Accept/Reject settles immediately; begin editor cancellation before collecting optional feedback.
- Rejection feedback is included in the block reason; acceptance feedback is deferred to the eventual tool result.
- Empty or cancelled feedback is absent. Preserve non-empty feedback exactly; feedback failure never invalidates the decision.
- `dismissed` means the user closed the prompt without deciding; `superseded` means another source won and closed it; `unavailable` means no interactive UI exists.
- Dismissal/unavailability blocks standalone prompt review, but is non-decisive while another viable review source remains.
- Overall review `aborted` means the complete review ended without a decision; it is distinct from prompt-level `superseded`.

### 2.7 Non-UI modes

- Workspace permission prompts fail closed without UI.
- `prompt` actions fail closed without UI.
- `allow` and `deny` retain their normal meanings.
- Explicit command-array handlers may run without Pi UI because the external program is itself a user interface.
- An external-handler failure without Pi UI blocks the operation.

### 2.8 Workspaces

- Pi's current session cwd is the automatically permitted primary workspace and is derived on demand rather than cached or persisted.
- The extension owns an ordered list of additional workspaces, persisted as full snapshots in Pi custom entries.
- An empty additional-workspace list permits only the primary workspace.
- Adding a workspace implies trust in its resources and rules.
- One-call outside-workspace approval does not alter the stored workspace list.
- Canonicalize additions with `realpath()` and persist the target identity rather than the supplied alias.
- Canonical exact duplicates are rejected/no-op with an informational message; preserve parent/child overlaps.
- Removal compares exact stored identity without dereferencing, so deleted or inaccessible entries remain removable.
- Effective additions/removals require UI confirmation identifying the path and impending reload; decline, cancellation, or unavailable UI leaves state unchanged.
- Preserve user order.
- Preserve parent/child and other overlapping workspace roots; do not infer or collapse project relationships.
- Workspace listings distinguish primary and additional paths without loading file contents.

Workspace resources:

- `<workspace>/.pi/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.pi/prompts`
- root instructions selected with `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` precedence;
- optional `.pi/APPEND_SYSTEM.md`.

Pi owns native resource and instruction discovery for the primary workspace. Additional-workspace skills and prompts are contributed through `resources_discover`, following deliberate symlinked resources transparently. Selected root instructions and `.pi/APPEND_SYSTEM.md` are reread and appended during `before_agent_start` with clear workspace/path provenance. Missing files are ignored; read failures warn non-blockingly. Never load `.pi/SYSTEM.md`, recursive instruction trees, or workspace extensions.

README must explain all loaded resources and recommend launching Pi from the project intended as the primary workspace. The extension cannot suppress resources Pi discovers independently from its cwd.

### 2.9 Commands

Register:

- `/tc:edit-config`
- `/tc:workspace-add [directory]`
- `/tc:workspace-remove [directory]`
- `/tc:workspace-list`
- `/tc:workspace-open [directory]`
- `/tc:workspaces-open`

`/tc:workspace-open` opens one stored workspace and generates a new group ID.

`/tc:workspaces-open` accepts no arguments, generates one group ID, and opens every stored workspace with that shared ID. Resolve a workspace-opener rule independently per path. Start the grouped opener commands together and report failures without preventing other workspaces from opening.

Pi currently parses extension command names up to the first space, so colon and kebab-case are valid. Protect this assumption with an extension-registration test and manual Pi check.

---

## 3. TOML Contract

### 3.1 Ordered rule objects

Every `handlers.<category>` and `hooks.<event>` category is an ordered array of rule objects. Conditions are keys prefixed with `var:` and the shared `action` field contains a decision or command. Handler actions may be decisions or commands where allowed; hook actions are command-only.

```toml
[[handlers.new_file_editor]]
"var:new_file_path" = '\.md$'
action = "prompt"

[[handlers.new_file_editor]]
"var:new_file_path" = '^/home/user/important/.*'
action = [
  "code",
  "--wait",
  { var = "new_file_path" }
]
```

Rules are evaluated in declaration order, and all conditions in one rule must match. For handlers, the final matching rule supplies the one selected action; users who need pipelines or sequential programs within that handler action should provide a wrapper executable. For hooks, every matching rule supplies a command and all matching commands execute in declaration order. An empty rule array is valid and behaves like an omitted category.

### 3.2 Regular-expression conditions

Condition values are JavaScript regular expressions, not globs.

Without flags:

```toml
"var:new_file_path" = '\.md$'
```

With flags:

```toml
"var:new_file_path" = ['\.md$', 'i']
"var:command_string" = ['^remove', 'i', 's']
```

The first array element is the expression and remaining elements are flags. Join and validate flags before constructing `RegExp`.

- Matching is substring-based unless the user adds anchors.
- Negative lookaheads can express exclusions.
- Reject invalid expressions, duplicate/unsupported flags, stateful `g`/`y`, and incompatible `u`/`v` combinations.
- Match file variables against normalized absolute paths.
- Match `command_string` against the raw command.
- Match every condition in a rule with logical AND.

No `minimatch` dependency is needed.

### 3.3 Commands and placeholders

```ts
type VariableName =
  | "config_file_path"
  | "new_file_path"
  | "old_content_file_path"
  | "new_content_file_path"
  | "command_file_path"
  | "command_string"
  | "directory_path"
  | "group_id"
  | "assistant_message_text"
  | "tool_name";

interface Placeholder {
  var: VariableName;
  prepend?: string;
  append?: string;
}

type CommandToken = string | Placeholder;
type Command = [string, ...Array<CommandToken>];
type Decision = "allow" | "deny" | "prompt";
```

Placeholder expansion produces exactly one argv element:

```text
prepend + resolved variable value + append
```

Do not split, interpolate, or reparse the result. Configured handler commands execute directly with `shell: false`. A user who wants shell behavior may explicitly configure `sh`, `bash`, or another shell as the executable and define quoting in their script/command.

Validate variables per handler context:

| Context                        | Available variables                              | Allowed action values  |
| ------------------------------ | ------------------------------------------------ | ---------------------- |
| `configuration_editor`         | `config_file_path`                               | command only           |
| hook `assistant_message_end`   | `assistant_message_text`                         | command only           |
| hook `tool_permission_request` | `tool_name`                                      | command only           |
| hook `agent_settled`           | none                                             | command only           |
| `workspace_opener`             | `directory_path`, `group_id`                     | command only           |
| `diff_editor`                  | `old_content_file_path`, `new_content_file_path` | decision or command    |
| `new_file_editor`              | `new_file_path`                                  | decision or command    |
| `command_editor`               | `command_file_path`, `command_string`            | decision or command    |

Unknown handler categories, variables, fields, and actions should produce useful validation errors. Unknown unrelated top-level keys may warn rather than fail to preserve forward compatibility.

#### Implementation checklist — Configuration Foundation

- [x] Select and add the TOML parser and Zod through pnpm.
- [x] Implement schemas for ordered handler/hook action rules, context-specific variables, regex specifications, commands, and placeholders.
- [x] Implement startup/on-demand TOML loading, safe fallback, and current warning reporting.
- [x] Implement JavaScript-regex condition matching and generic last-match-wins rule resolution.
- [x] Implement one-argument placeholder expansion with optional `prepend`/`append`.
- [x] Add plain behavioral tests for malformed config, regex flags, multiple conditions, rule precedence, invalid variables/actions, and live config changes.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve the config model and rule semantics before connecting handlers.

### 3.4 Representative config

The generated starter file is the complete commented reference. Representative entries use the shared `action` field:

```toml
[[handlers.configuration_editor]]
action = ["code", "--wait", { var = "config_file_path" }]

[[handlers.command_editor]]
"var:command_string" = '^rm\s+-rf'
action = "prompt"

[[hooks.tool_permission_request]]
action = ["notify-send", "Permission requested", { var = "tool_name" }]
```

Initial command-only hooks are `assistant_message_end`, `tool_permission_request`, and `agent_settled`.

### 3.5 Config editing

Depends on the configuration-foundation checkpoint above. `/tc:edit-config` accepts no arguments:

1. Create the global config directory if necessary.
2. Atomically create the fully commented starter TOML when absent.
3. Launch the last matching direct-argv `configuration_editor` action when configured.
4. Otherwise open the current source in Pi's multiline editor when UI is available.
5. Pi-editor cancellation preserves the current file; returned text, including empty text, is written atomically. Config-save temporary-file cleanup requires successful exclusive opening: preserve an existing colliding path, attempt closure after writing, and remove only the owned temporary file after write, close, or rename failure while preserving the original error.
6. If a configured editor fails to start, exits nonzero, or is signal-terminated, report the failure, reread the current file, and fall back to Pi's multiline editor when UI is available.
7. A clean configured-editor exit does not trigger fallback.
8. Without UI, do not open fallback input. With no configured handler, leave the current source unchanged; after a configured-editor failure, preserve its actual filesystem effects and report the non-interactive outcome rather than claiming the file was untouched.
9. Reparse after the editor flow and show current validation warnings.

Stop config editing when runtime shutdown begins: do not admit a new command, launch an editor after asynchronous preparation/resolution, open fallback after shutdown terminates an editor, save Pi-editor text returned after shutdown, or begin revalidation/completion notifications. Return a typed shutdown outcome. Filesystem writes or editor side effects already in progress remain best-effort and are not rolled back.

Do not interpret command arguments or environment variables as shell source. Cross-platform shell parsing and platform-specific editor fallbacks are outside the initial release.

#### Implementation checklist — Command Execution and Config Editing

This checkpoint applies the configuration contract to a real user workflow and establishes the process boundary reused by later review handlers (Section 6.3).

Implementation:

- [x] Provide the direct-argv process boundary with tracked completion, cancellation, and idempotent cleanup.
- [x] Enforce direct-argv-only editor selection.
- [x] Generate the complete commented configuration reference.
- [x] Connect argument-free config editing to the effective config path and UI/non-UI outcomes above.
- [x] Revalidate after editing and report current warnings.
- [x] Implement the failure → warning → reread → UI fallback sequence above without altering clean-exit or non-UI semantics.

Evidence:

- [x] Cover argument integrity, process outcomes, cancellation, starter creation, handler selection, save/cancel, and non-UI behavior.
- [x] Cover all three editor failures, warning/fallback ordering, externally changed source, revalidation, and clean-exit behavior.
- [x] Inspect and edit generated configuration manually in Pi.
- [x] Verify the initial workflow with typechecking and all tests.
- [x] Verify failure recovery manually and rerun the complete suite.

**Review checkpoint:** Approve process behavior and the generated configuration reference.

---

## 4. Architecture and Pi Lifecycle

### 4.1 Pi guarantees to verify and use

- `tool_call` may block before execution.
- Sibling tool calls are preflighted sequentially, then allowed calls may execute concurrently.
- `tool_result` runs after tool execution and may patch content/details/error state.
- `tool_execution_end` can provide defensive final cleanup.
- `resources_discover` accepts skill and prompt paths.
- `pi.appendEntry()` persists extension state outside model context.
- `ctx.sessionManager.getBranch()` returns state on the active session branch.
- `ctx.reload()` tears down and replaces extension runtime state; treat it as terminal in its command handler.
- `createWriteToolDefinition` and `createEditToolDefinition` are public Pi exports in the supported baseline and can run the actual built-in tools with controlled arguments.

Pin/document the supported Pi version and recheck these assumptions during upgrades.

#### Implementation checklist — Project and Pi Compatibility Baseline

- [x] Confirm the supported Pi/Node versions, required public exports, event ordering, and `tc:*` command naming.
- [x] Establish the extension entry point and modular source/test layout.
- [x] Configure pnpm-based TypeScript and test tooling for nested modules.
- [x] Add a fake-API extension registration test covering the entry point and namespaced commands.
- [x] Add scripts for unit tests, wiring tests, typechecking, and the complete verification suite.
- [x] Manually load the minimal extension in Pi and invoke a `tc:*` command.
- [x] Run all checks and document compatibility assumptions.

**Review checkpoint:** Approve structure, tooling, and Pi assumptions before adding runtime behavior.

### 4.2 Module ownership

Feature modules live under `extensions/src/`; `extensions/src/index.ts` composes their public operations into Pi lifecycle handlers. Types and message contracts belong in feature-local `types.ts` and `messages.ts`. Cross-feature production consumers import public operations, types, and messages through the owning feature's `index.ts`; add public exports only for implemented consumers. Same-feature implementation modules may use relative imports, and focused internal utility specs may import the module they exercise directly. Tests live under `extensions/tests/` at the unit, wiring, or targeted compatibility layer.

| Responsibility | Owning features | Evidence/checkpoint |
| --- | --- | --- |
| Configuration and editing | `config-loader`, `config-editor`, `process` | Sections 3.3 and 3.5 |
| Workspace identity and commands | `workspaces`, `paths` | Section 5.4 |
| Additional resources and instructions | `workspace-resources`, `workspace-context` | Section 5.5 |
| Outside-workspace authorization | `path-permissions` | Section 5.2 |
| Decisions and policy interpretation | `review-prompts`, `review-policies` | Section 6.2 |
| Cross-event ownership and feedback | `path-reservations`, `post-tool-actions` | Sections 6.2 and 6.7 |
| Future editor coordination and previews | Focused modules designed at their checkpoints | Sections 6.4–6.8 |

Keep interfaces narrow and external boundaries injectable so each leaf can be verified before composition. Do not create future scaffolding merely to match this ownership map.

### 4.3 Runtime state

Store persistent configuration under `<effective PI_CODING_AGENT_DIR>/teleprompt-commentary/`. Keep ephemeral review artifacts in one securely created, uniquely named extension runtime directory beneath the operating system's temporary directory, with tracked shutdown cleanup. After exclusive temporary-file creation, attempt handle closure even if writing fails. Preserve the exact write error when both writing and closing fail; report the close error when writing succeeds, and attempt removal of the owned artifact on either failure.

```ts
type PostToolAction =
  | {
      type: "apply-reviewed-content";
      targetPath: string;
      reviewedContent: string;
    }
  | {
      type: "append-user-feedback";
      feedback: string;
    };

// Conceptual ownership, not a required monolithic runtime object:
// - ordered additional workspaces;
// - post-tool actions keyed by tool-call ID;
// - canonical path reservations;
// - locally owned review sessions and tracked child processes.
```

The review itself is not pending after `tool_call`; only explicit post-tool actions are deferred. A short-lived `FileReviewSession` owns original bytes/existence, temporary paths, child process, and restoration metadata. It must be cleaned before the original Pi tool executes.

On `session_shutdown`:

- abort/terminate tracked handlers;
- restore in-flight file sessions;
- remove temporary resources;
- clear post-tool actions and reservations.

Cleanup must be idempotent.

Reservations, active reviews, tracked processes, and deferred actions remain local to the current extension runtime. Do not add durable journals, reload-persistent registries, ownership transfer, OS locks, or transactional recovery initially. Restore preview state before returning from `tool_call` where practical. Mid-call reloads, detached/crashed editors, and filesystem TOCTOU races may defeat coordination or cleanup; document these best-effort limitations and rely on normal version-control/user recovery safeguards.

### 4.4 Path reservations

Use an in-memory canonical-path reservation map, not an OS lock and not Pi's `withFileMutationQueue`.

- Reserve every `write`/`edit` during preflight.
- If another active tool call owns the same canonical path, block with a clear retry-after-result reason.
- Release immediately when this extension blocks/rejects the call.
- Retain through allowed execution and release after `tool_result` post-actions.
- Use `tool_execution_end` as an idempotent defensive release path when appropriate.
- Clear on shutdown.

Pi's own mutation queue serializes built-in filesystem execution. Our reservation instead makes conflicts visible by blocking rather than silently queueing. It coordinates only this extension process and does not constrain `bash`, custom tools, or external programs.

### 4.5 Explicit asynchronous state machines

The prompt/editor race and file lifecycle should have centralized ownership and discriminated outcomes, not independent callbacks that all mutate files/state.

```ts
type ReviewOutcome =
  | { type: "accepted"; feedback?: string }
  | { type: "rejected"; feedback?: string }
  | { type: "externally-modified"; content: string }
  | { type: "aborted" };
```

The coordinator should:

1. start available decision sources;
2. accept the first decisive outcome;
3. cancel and await the loser;
4. prevent late callbacks from changing settled state;
5. return one typed outcome;
6. leave filesystem restoration to one surrounding `finally` path.

No state-machine library is required. Use explicit types, one transition owner, and tests for each ordering.

---

## 5. Workspace Paths, Persistence, and Resources

### 5.1 Path tools and normalization

Gate these built-in inputs:

| Tool    | Path                              |
| ------- | --------------------------------- |
| `read`  | `input.path`                      |
| `write` | `input.path`                      |
| `edit`  | `input.path`                      |
| `grep`  | `input.path`, or cwd when omitted |
| `find`  | `input.path`, or cwd when omitted |
| `ls`    | `input.path`, or cwd when omitted |

Do not infer path fields on arbitrary custom tools. Implement extraction as `Array<string>` so future known multi-path tools can be added safely.

Mirror Pi path behavior:

1. strip accepted leading `@`;
2. expand `~`;
3. resolve relative paths from `ctx.cwd`;
4. normalize `.`/`..` and separators;
5. `realpath` existing targets;
6. for missing targets, realpath the nearest existing ancestor and append the missing suffix;
7. canonicalize literal, already-resolved workspace roots without tool-input transformations;
8. test containment with `path.relative`, never string prefixes.

For `read`, select the same existing filename candidate as Pi before canonicalization and containment checks: original, AM/PM narrow-space variant, NFD variant, curly-apostrophe variant, then combined NFD/curly-apostrophe variant. Mirror the supported Pi baseline through a local adapter rather than private imports, and verify selection against the actual native read tool before widening compatibility. Other tools do not use read-specific fallbacks.

Use normalized absolute values for regex contexts. Do not rewrite original tool arguments merely for review.

### 5.2 Permission sequence

For supported path tools:

1. Normalize every extracted path.
2. Continue if every path lies in at least one workspace.
3. Otherwise emit `tool_permission_request` and show one Allow/Deny prompt listing the outside paths.
4. Allow applies to this call only.
5. Deny, cancel, or unavailable UI blocks.
6. After approval, proceed to write/edit policy resolution when relevant.

The workspace gate always precedes the write/edit review prompt.

#### Implementation checklist — Path Permission Gates

- [x] Implement Pi-compatible canonical path resolution and containment checks, including missing targets below symlinks.
- [x] Add typed path extractors for `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- [x] Implement the one-call outside-primary-and-additional-workspaces Allow/Deny gate before file policy resolution.
- [x] Fail closed when the workspace gate requires unavailable UI.
- [x] Test descendants, parents, sibling prefixes, automatic primary-workspace permission, empty additional workspaces, symlinks, and future multi-path extraction.
- [x] Add extension wiring tests for every supported built-in path tool.
- [x] Manually verify inside/outside path calls in Pi.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve path semantics and the permission-gate UX.

### 5.3 Snapshot persistence

```ts
const WORKSPACE_ENTRY = "teleprompt-commentary.workspaces";

interface WorkspaceSnapshot {
  additionalWorkspaces: Array<string>;
}
```

Append a complete snapshot after every effective add/remove. Restore by:

1. getting `ctx.sessionManager.getBranch()`;
2. scanning from the active leaf toward the root;
3. selecting the first valid matching snapshot;
4. honoring a valid empty snapshot;
5. defaulting to `[]`.

Do not use all session entries: another branch may contain a later unrelated workspace snapshot. Do not use compacted model context: workspace state must survive conversation compaction.

### 5.4 Commands

- `workspace-add`: argument or input prompt; require an existing directory; canonicalize; reject exact canonical duplicates and primary-workspace additions; preserve overlaps/order; confirm with UI; snapshot; `await ctx.reload(); return`.
- `workspace-remove`: exact argument or stored-path selector; confirm with UI; snapshot; reload. Removal compares stored identity without dereferencing, so inaccessible entries remain removable.
- `workspace-list`: show ordered paths or a clear empty state.
- `workspace-open`: argument or selector; generate UUID; resolve and directly spawn the last matching opener.
- `workspaces-open`: no arguments; one UUID for all paths; resolve each independently and start the resulting commands as one best-effort group.

Add/remove commands capture a runtime-only workspace revision before asynchronous work. Increment it on session/branch restoration (even for identical lists) and successful mutations. If shutdown starts or the revision changes during path input/selection, resolution, or confirmation, discard the pending change without a snapshot, state update, or reload. Report a retry warning for stale state while UI is available; shutdown cancellation is silent. This guards asynchronous ordering without claiming that ordinary Pi UI permits concurrent branch switching and without adding locks or durable recovery state.

Both opener commands reject admission after runtime shutdown and recheck shutdown after asynchronous workspace lookup or selection. Each opener rechecks shutdown after handler resolution and before spawning, preventing processes from starting after shutdown's cleanup pass. Observe opener completion without awaiting it in the command flow. Report observation rejection and unsuccessful completion best-effort, contain throwing warning callbacks in resolver/startup/completion paths, and suppress opener warnings after shutdown; one opener's failure must not disrupt the group or create an unhandled rejection.

List primary and additional workspaces separately. Diagnose invalid, duplicate, primary-removal, or unknown entries before confirmation. Confirm effective changes with the path and reload consequence; persist before reloading, without a transient success notice. If primary-workspace resolution fails, warn with the cause, retain raw cwd only for display, and continue useful list/group-open behavior for stored additional workspaces. Group-open explicitly reports that arguments are unsupported.

#### Implementation checklist — Workspace State, Persistence, and Commands

- [x] Derive the automatically permitted primary workspace from current `ctx.cwd` on demand without caching or persisting it; retain only canonical ordered additional-workspace state, with exact-duplicate rejection and preserved overlaps.
- [x] Implement the unversioned snapshot contract above and restore the nearest valid active-branch entry, including an empty list.
- [x] Implement `/tc:workspace-add`, `/tc:workspace-remove`, and `/tc:workspace-list` with primary/additional workspace wording, separate listing, and confirmation before effective state changes.
- [x] Persist snapshots before resource reloads and treat reload as terminal to the command handler.
- [x] Implement `/tc:workspace-open` and `/tc:workspaces-open` with per-invocation group IDs and generic rule variables.
- [x] Test primary/additional separation, duplicates, parent/child roots, removal to empty, branch divergence, argument/input/select flows, group IDs, and partial opener failures.
- [x] Manually exercise every workspace command and session resume/tree behavior.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve workspace state, branching behavior, and command UX.

### 5.5 Resource and rules loading

During `resources_discover`, contribute existing directories from additional workspaces only:

- `<workspace>/.pi/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.pi/prompts`

For additional workspaces during `before_agent_start`:

- list primary/additional workspace paths and runtime authorization behavior;
- state that `bash` is not workspace-gated;
- instruct the agent not to issue parallel same-path mutations;
- select `AGENTS.override.md`, otherwise `AGENTS.md`, otherwise `CLAUDE.md`;
- also append `.pi/APPEND_SYSTEM.md`;
- reread selected sources and append them with workspace/path attribution;
- keep missing files silent and warn on read failures.

Pi owns primary-workspace instructions. Follow deliberate symlinked resources transparently, including links outside the selected root; do not impose containment on these trusted resources. Preserve source text exactly and use Pi's no-indentation, blank-line-separated context formatting. Do not load themes, workspace config, context-file trees, `.pi/SYSTEM.md`, or workspace extensions.

#### Implementation checklist — Workspace Resources, Rules, and Agent Context

- [x] Discover existing `.pi/skills`, `.agents/skills`, and `.pi/prompts` directories for Pi, following deliberate symlinked resources transparently.
- [x] For additional workspaces, load root instructions with `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` precedence plus `.pi/APPEND_SYSTEM.md`, and reread them before each agent run.
- [x] Append attributed, concise workspace boundaries/rules and same-path mutation guidance to the system prompt.
- [x] Let Pi own primary-workspace instructions; never duplicate them or load workspace extensions, recursive rules, `.pi/SYSTEM.md`, or unsupported resources.
- [x] Test resource filtering/order, instruction precedence, primary-workspace exclusion, missing/read-failing files, reload, and generated system-prompt text.
- [x] Manually verify skill/prompt discovery and workspace rules in Pi.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve loaded resources and exact agent-facing context.

---

## 6. Review and Execution Pipelines

### 6.1 Generic rule resolution

For an action:

1. Construct every real variable owned by that handler workflow.
2. Load config on demand.
3. Select the handler or hook category and match all its regex conditions.
4. Select the final matching rule.
5. Apply the category default when none matches.
6. Execute only the selected handler.

Resolve a category only after all of its declared variables exist. Do not use placeholder paths or partially evaluate rules: `diff_editor` resolution belongs to the file-preview workflow that owns `old_content_file_path`, and `command_editor` resolution belongs to the Bash workflow that owns `command_file_path`. `new_file_editor` likewise resolves in the complete file workflow so file-policy categories remain composed in one place.

### 6.2 Basic review composition

This stage connects default/basic policy evaluation, prompt decisions, feedback, and the reservation lifecycle from Section 4.4. It defines the composition boundary that later file and Bash workflows call after resolving their complete handler contexts; it does not create preview/temporary artifacts or launch external editors, which belong to Sections 6.4–6.8.

1. Complete the workspace gate before reserving a file target or evaluating file policy. Bash skips the workspace gate.
2. Apply the defaults in Section 2.2 for basic/default paths. Later owning workflows resolve configured category actions only after constructing all real variables, then pass those actions through the same `resolveReviewPolicy()` and `evaluateReviewPolicy()` boundary.
3. Explicit `allow` proceeds and `deny` blocks without a review notification. `prompt` invokes the standalone decision/feedback workflow. Resolved command actions produce `external-review-required`, never implicit approval.
4. For a standalone prompt, dismissal, unavailable UI, or decision failure blocks. Acceptance/rejection remains decisive if optional feedback fails.
5. Include rejection feedback in the block reason and release reservations. Store acceptance feedback by tool-call ID for the result handler.
6. On `tool_result`, take deferred actions once and append feedback as new text content. Return only a content patch so Pi retains its current details, error state, and usage. Release reservations after post-actions, with defensive execution-end/shutdown cleanup.

The checklist below closes the reusable basic-review composition and its default runtime paths, not artifact-dependent category resolution. Sections 6.8 and 6.6 resolve `command_editor` and file-editor rules respectively and supply their complete contexts to this boundary. The external-review coordinator must consume the immediate decision operation separately so feedback never delays cancellation of the losing editor.

#### Implementation checklist — Basic Review Policies, Feedback, and Reservations

- [x] Implement Accept/Reject prompts with optional feedback for either decision.
- [x] Wire the verified policy resolver/evaluator into default file and command paths, expose the same boundary for later fully resolved handler actions, and preserve explicit external-review handoff without placeholder artifact paths.
- [x] Implement typed post-tool actions for acceptance feedback.
- [x] Implement in-memory canonical path reservations for every `write`/`edit`, with explicit same-path conflict blocking.
- [x] Add defensive release/cleanup across rejection, result, execution end, and shutdown.
- [x] Test the default and resolved-action decision matrix, feedback delivery, workspace-before-review ordering, reservation conflicts, and no-UI prompt behavior; leave artifact-dependent config resolution to its owning workflow evidence.
- [x] Manually verify default file prompts, feedback, and same-path block reasons.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve policies, feedback semantics, and reservation lifecycle before external editors.

### 6.3 Process helper

Configured commands use `spawn(executable, args, { shell: false })` and support:

- startup/completion result;
- cancellation;
- runtime child tracking;
- bounded termination attempts;
- idempotent cleanup.

Begin with Node's portable child termination behavior. Add platform-specific termination only if tests demonstrate a need. Document that killing launcher processes cannot reliably stop detached GUI editors. Waiting editor flags remain the user's responsibility.

Hook failures are always swallowed. Review-handler failures follow UI/non-UI behavior described earlier.

### 6.4 Race coordinator

Depends on the basic-review checkpoint and the process boundary established by config editing. This checkpoint approves asynchronous coordination independently of file mutation; Bash review consumes it next.

A naive `Promise.race` is insufficient because it does not cancel the loser and editor failure is non-decisive while a Pi prompt remains available.

The coordinator must:

- race only decisive outcomes;
- abort a stale Pi prompt when the editor decides;
- cancel and await an opaque external-review operation when Pi decides;
- keep the prompt alive after external-review startup/completion failure;
- settle exactly once;
- expose deterministic fake source interfaces for tests.

The coordinator does not import `ProcessRunner` or process completion types. External-review adapters translate tracked process completion and termination into the coordinator's generic external outcomes. This stage verifies caller-driven cancellation, idempotent cleanup, unconfirmed cancellation, and late callbacks with fake operations. Section 6.8 owns the first process-backed adapter and runtime-shutdown wiring; file review later reuses that boundary.

#### Implementation checklist — Review Race Coordinator

- [x] Implement one typed coordinator that owns prompt/editor outcomes and settles once.
- [x] Cancel and await the losing source; keep the prompt active after non-decisive editor failure.
- [x] Support external-editor-only decisions in non-UI mode.
- [x] Integrate caller-driven cancellation and idempotent external-operation cleanup, including explicit unconfirmed cancellation outcomes.
- [x] Test each completion ordering, late callbacks, startup/nonzero failures, cancellation, and shutdown with fakes.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve the explicit async state transitions and cancellation guarantees independently of file mutation.

### 6.5 Pi-powered file preview

This checkpoint proves snapshot/restoration correctness before any external file editor is attached. Target classification may be developed earlier for basic policies, but preview mutation and restoration remain incomplete until the evidence below is approved.

Production preview adapters call Pi's actual public built-in definitions with the original input and current cwd/context:

```ts
createWriteToolDefinition(ctx.cwd);
createEditToolDefinition(ctx.cwd);
```

The snapshot is taken first; the real Pi definition writes the proposal to the actual target. No custom write/edit proposal implementation or parity clone is needed. Snapshot capture rejects existing non-regular targets before opening them, avoiding a blocking FIFO open, and retains the handle-level regular-file check afterward. The check/open filesystem race remains a documented TOCTOU limitation. FIFO regression fixtures stay under an OS-temporary root and run snapshot capture in a timeout-bounded child process on supported platforms.

Existing-file restoration checks the target with `lstat()` before opening it and rejects non-regular or identity-changed replacements, including a symlink pointing to the moved original. Retain the handle-level identity check before writing. These checks preserve replacements detected before mutation, not protection against the documented check/open filesystem race.

Snapshot capture and existing-file restoration always attempt handle closure. Preserve the exact primary operation error when closure also fails; otherwise report the close error. Reviewed-content application follows the same precedence and retains owned-temporary-file cleanup on failure.

If preview execution fails:

- restore state;
- do not present a misleading external preview;
- allow the normal original tool execution to report its native error, unless another independent gate already denied it.

Tests should directly run these production adapters against temporary fixtures and verify they use Pi's actual behavior.

For a new target, the snapshot records its nearest existing ancestor and every intermediate directory absent before preview. Before destructive cleanup, validate those parent paths shallow-to-deep against their captured directory identities. Missing parents remain compatible with idempotent cleanup; an existing untracked, replaced, non-directory, or unreadable parent stops restoration with an incomplete outcome identifying the first unsafe parent, without deleting the target or any directories. Once validation succeeds, restoration removes the preview target, then attempts non-recursive empty-directory removal for only those initially missing directories, deepest first, retaining the immediate identity checks before removal. Never recursively delete intermediate directories or remove directories that existed before preview. Leave nonempty, replaced, or otherwise unsafe directories intact. Cleanup is idempotent and best-effort under the documented TOCTOU limitation.

#### Implementation checklist — Pi-Powered File Preview

- [x] Implement injectable production adapters around Pi's public `createWriteToolDefinition` and `createEditToolDefinition`.
- [x] Snapshot existing/new target state before invoking the real Pi preview tool; for a new target, record its nearest existing ancestor and every initially missing intermediate directory.
- [x] Restore new targets by removing the preview target and attempting non-recursive empty-directory removal for only those initially missing directories, deepest first; never recursively delete or remove pre-existing/nonempty/replaced directories.
- [x] Track preview-created state and implement reliable, idempotent best-effort restoration.
- [x] Add targeted compatibility tests that run Pi's actual tool definitions against temporary fixtures.
- [x] Test native preview errors, existing/new targets, metadata/empty contents, complete restoration, nested missing parents, and preservation when intervening content prevents directory removal.
- [x] Document local built-in tool assumptions and override/remote limitations.
- [x] Run typechecking and all tests.

**Review checkpoint:** Inspect real filesystem state and approve preview/restoration before attaching editors. Approved after full verification.

### 6.6 File `tool_call`

This section and Section 6.7 compose the already-approved basic policies, race coordinator, and native preview. Their joint checkpoint below Section 6.7 approves the complete file lifecycle, not a second implementation of those leaves.

```text
normalize target
run workspace gate
acquire path reservation or block
load config and classify existing/new
resolve diff_editor/new_file_editor; default to prompt

allow:
  retain reservation and proceed

deny:
  release reservation and block

prompt:
  notify, ask Accept/Reject + optional feedback
  reject -> release and block
  accept -> register feedback action if present; retain reservation; proceed

command:
  snapshot target
  invoke actual Pi tool to write proposal
  notify
  coordinate editor and optional Pi prompt
  capture reviewed content/feedback
  restore target and clean temporary resources
  reject -> release and block
  accept/reviewed -> register post-tool actions; retain reservation; proceed
```

Diff variables:

- `old_content_file_path`: secure temporary original snapshot;
- `new_content_file_path`: actual target containing Pi's proposal.

New-file variable:

- `new_file_path`: actual new target containing Pi's proposal.

### 6.7 File `tool_result`

For every reserved `write`/`edit` result:

1. Retrieve any actions keyed by `event.toolCallId`.
2. Apply `apply-reviewed-content` regardless of original `isError`.
3. Append concise success/failure explanation without diff/full content.
4. Append optional acceptance feedback.
5. Preserve original result blocks and `isError`.
6. Delete any actions and release the reservation in `finally`, including when no post-tool actions exist.

Use atomic replacement where practical without inventing cross-platform complexity prematurely.

#### Implementation checklist — External File Review and Post-Tool Actions

- [x] Connect `diff_editor` and `new_file_editor` rules to actual-target Pi preview and the race coordinator.
- [x] Capture user-reviewed content, restore pre-review state, and register explicit post-tool actions.
- [x] Apply reviewed content and acceptance feedback in `tool_result` while preserving Pi's original result/error state.
- [x] Release reservations and clear actions in every success/failure path, with defensive end/shutdown cleanup.
- [x] Keep agent annotations concise and exclude diffs/full file contents.
- [x] Test changed/unchanged/empty content, prompt/editor orderings, original-tool failure, post-apply failure, same/unrelated paths, and cleanup exactly once.
- [x] Add extension wiring scenarios that manually orchestrate `tool_call`, Pi's real tool execution, and `tool_result` without simulating an agent loop.
- [x] Manually verify existing/new file review with real editors in Pi.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve complete write/edit behavior, filesystem results, and agent-visible annotations. Approved after full verification and user-confirmed VS Code manual checks.

### 6.8 Bash `tool_call`

Depends on the coordinator, but not file preview. The delivery order therefore places this checkpoint before native file preview even though the reference sections group file operations together.

```text
read raw command
load config and resolve command_editor
no match -> preserve normal Pi behavior
allow -> proceed
deny -> block
prompt -> Accept/Reject + optional feedback
command -> write command temp file and coordinate editor/prompt
```

Changed, non-empty external command content replaces the current Bash tool input after a successful waiting-editor exit; closing the editor is authorization, so no additional prompt or agent round-trip occurs. Empty edited content blocks execution. Annotate the tool result with the complete command Pi received for execution because Pi retains the original assistant proposal in its tool-call record. Clean temporary data on every path. Prompt acceptance feedback becomes a post-tool action; rejection feedback becomes the block reason. If cancellation of the losing command editor is unconfirmed (including failed termination), prompt acceptance must block execution with a termination diagnostic instead of allowing the original command or deferring approval feedback. Artifact cleanup remains best-effort and runs on this blocked path.

#### Implementation checklist — External Bash Review

- [x] Implement secure command temporary-file creation and cleanup under the unique extension runtime temporary directory.
- [x] Connect `command_editor` command handlers to the race coordinator through a tracked process-backed adapter, including runtime-shutdown cancellation and typed unconfirmed termination.
- [x] Accept unchanged commands, preserve acceptance feedback, execute non-empty edited commands through the current Pi Bash tool input, and block empty edits.
- [x] Annotate the tool result with the exact command sent for execution when it differs from the original proposal; leave user `!`/`!!` untouched.
- [x] Test UI/non-UI outcomes, changed/unchanged/empty content, raw regex matching, exact executed-command annotations, feedback, failures, and cleanup.
- [x] Manually verify changed-command execution and its transcript annotation with a real waiting editor in Pi; earlier block/suggestion behavior was manually verified.
- [x] Run typechecking and all tests after the behavior change.

**Review checkpoint:** Approve complete bash-review behavior and agent-facing results.

---

## 7. Event Hooks

Command-only `hooks.<event>` rule arrays execute every matching action in declaration order. Each command is dispatched independently, and one hook command's failure does not suppress later matching commands or affect Pi's underlying flow.

Initial hooks and variables:

| Hook                      | Variables                |
| ------------------------- | ------------------------ |
| `assistant_message_end`   | `assistant_message_text` |
| `tool_permission_request` | `tool_name`              |
| `agent_settled`           | none                     |

Dispatch `assistant_message_end` from Pi's `message_end` only when `message.role === "assistant"`. Build `assistant_message_text` with one `Tool "<name>" is being called.` line per tool call in message order, followed by the assistant's text blocks, joined with newlines. Exclude tool arguments and thinking. Skip dispatch when the combined message is empty or whitespace-only. Fire `tool_permission_request` only immediately before an actual interactive Pi permission prompt. Do not fire it for explicit allow/deny, normal no-op behavior, unavailable non-UI prompts, or external-editor-only review. Load config on demand, expand placeholders, spawn directly, and swallow all hook failures without affecting Pi. Recheck runtime shutdown before each command launch after asynchronous configuration loading; review permission hooks must also recheck whether their prompt has been cancelled or superseded.

#### Implementation checklist — Event Hooks

- [x] Implement best-effort dispatch of every matching hook command in declaration order.
- [x] Add `assistant_message_end`, `tool_permission_request`, and `agent_settled` dispatch with their defined hook variables.
- [x] Fire `tool_permission_request` only before actual interactive Pi permission prompts, not explicit allow/deny, normal no-op, unavailable non-UI prompts, or external-editor-only review.
- [x] Ensure hook command failures never alter Pi behavior; do not add unnecessary content sanitization initially.
- [x] Test event filtering, declaration ordering, multiple matches, placeholder expansion, suppression, fixed values, and independently swallowed failures.
- [x] Manually test configured hook commands, including a desktop-notification command if available.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve hook timing, frequency, variables, and failure isolation. Approved after user-confirmed full automated and manual verification.

---

## 8. Dependencies and Package Setup

Expected runtime dependencies:

- a maintained ESM-compatible TOML parser;
- Zod.

JavaScript `RegExp` replaces minimatch. All configured commands use direct argv execution, so no shell tokenizer is required.

Before adding dependencies:

- use **pnpm only**;
- explain intended commands and receive review approval;
- verify Node/ESM/Pi jiti compatibility;
- place runtime dependencies under `dependencies`;
- inspect package license/maintenance;
- add focused parser-order/schema tests.

Project setup must:

- point `pi.extensions` to the actual entry;
- include nested TypeScript/tests in `tsconfig`;
- add local typecheck/test tooling;
- publish all extension modules and starter-template source;
- document the supported Pi and Node versions.

---

## 9. Testing Strategy

The scenarios here define evidence for the feature-local checklists; they are not a separate backlog. Verify them as each owning feature is implemented. The final regression checkpoint adds cross-feature failure/recovery evidence rather than postponing feature tests until the end.

The user runs verification and manual Pi checks under the working agreement. Manual and ad hoc filesystem fixtures—including primary/additional workspaces, outside paths, and symlinks—must all remain beneath a dedicated OS temporary root.

Automated testing has three layers only:

1. **Pure module tests** for logic owned by this project.
2. **Extension wiring tests** using a fake `ExtensionAPI` and controlled event contexts. These replace only Pi's extension registration/dispatch slice, not the model or complete agent loop.
3. **Targeted Pi compatibility tests** that invoke public Pi tool definitions directly with temporary files.

Do not build fake model APIs, scripted providers, RPC agent-loop infrastructure, or automated full-model integration tests initially. Test real TUI/lifecycle behavior manually in Pi, then turn discovered behavior into focused module/wiring regression tests.

Optional Ollama/Gemma 3 testing may be added near release as a manual smoke test, not as part of `pnpm test`.

### 9.1 Configuration scenarios

- Given no config file, loading returns defaults without warning.
- Given malformed TOML or schema/regex errors, the action warns and falls back without crashing Pi.
- Given several matching rules, only the final matching rule is selected.
- Given multiple conditions in one rule, it matches only when every condition matches.
- Given regex arrays, supported flags work and invalid/stateful combinations warn.
- Given placeholder prepend/append and values containing spaces, each expansion remains one argument.
- Given a command-only category, decision strings are rejected.
- Given the config changes after startup, the next affected action sees the new config.
- Given the same configuration error repeats, each load reports its current warning without historical suppression.

### 9.2 Workspace/path scenarios

- Given `/work/app` is allowed, `/work/app/file` is allowed but `/work/application/file` and `/work` are not.
- Given an existing symlink or missing path below a symlink ancestor, canonical containment prevents an apparent workspace escape.
- Given `path` is omitted from `grep`, `find`, or `ls`, current cwd is checked as the automatically permitted primary workspace; canonical resolution failures still block.
- Given no additional workspaces, supported path tools inside the primary workspace proceed without the outside-workspace gate.
- Given a canonical duplicate workspace, add is a no-op; given parent/child roots, both remain.
- Given snapshots on different session branches, restoration chooses the latest snapshot nearest the active leaf, including a valid empty snapshot.
- Given workspace add/remove, the snapshot is persisted before reload and resources refresh afterward.
- Given additional-workspace resources, only supported skill/prompt directories, root instruction precedence, and `.pi/APPEND_SYSTEM.md` are contributed; extensions are not loaded.
- Given single/group workspace open, group IDs are unique per invocation and shared within one all-workspaces operation.

### 9.3 Prompt/process/race scenarios

- Given Accept or Reject, optional feedback is collected in either case.
- Given editor decides first, the stale Pi prompt is aborted.
- Given Pi decides first, the editor is cancelled and awaited before restoration.
- Given editor startup/nonzero failure with UI, the prompt remains available.
- Given editor failure without UI, the operation blocks.
- Given shutdown during review, the child is terminated and filesystem restoration runs once.
- Given a late losing callback, it cannot change the settled outcome.

### 9.4 File scenarios

- Given preview is required, the production adapter invokes Pi's actual built-in tool definition against the target.
- Given preview fails natively, state is restored and Pi's normal tool later reports its own error.
- Given the editor exits unchanged, original state is restored before Pi's normal tool executes.
- Given the editor changes content, reviewed content is captured, original state restored, normal tool run, then reviewed content applied.
- Given Pi's normal tool fails, reviewed content is still attempted while the original error remains visible.
- Given reviewed-content application fails, the original result remains and a concise failure annotation is appended.
- Given empty reviewed content, it is treated as intentional.
- Given two same-path mutations overlap, the first reserves the path and the second is blocked until a later retry.
- Given unrelated paths, reservations do not conflict.
- Given controlled failure/cancel paths, cleanup is idempotent and owned by one operation. Mid-call reload and external filesystem races remain best-effort limitations, not guarantees tested away.

### 9.5 Bash and notification scenarios

- Given no command rule, agent bash is untouched.
- Given a changed, non-empty external command, Pi executes the exact edited text in the current Bash call and the tool result identifies it; an empty edit blocks execution.
- Given prompt acceptance with feedback, the command runs and feedback appears in its result.
- Given user `!`/`!!`, no interception occurs.
- Given each configured hook event, every matching hook runs in declaration order with its context-specific variables.
- Given explicit allow/deny or normal no-op, no permission notification runs.
- Given hook process failure, Pi behavior is unchanged.

### 9.6 Extension wiring and manual Pi checks

Wiring tests should load the real extension factory into a fake API, capture handlers/commands, and manually invoke only the relevant event slice. They must not emulate model inference, retries, compaction, or the whole agent loop.

Manual checks at each review checkpoint should cover newly introduced real Pi behavior, including:

- extension and `tc:*` command discovery;
- prompts and optional feedback;
- session resume/tree behavior;
- reload/resource discovery;
- editor wait/cancellation behavior;
- tool result annotations and block reasons;
- non-UI external handlers where practical;
- real Vi/VS Code/Zed behavior as supported.

Record manual discoveries and add regression tests at the lowest useful automated layer.

#### Implementation checklist — Wiring, Manual Regression, and Failure Recovery

See [`stage13_verification.md`](./stage13_verification.md) for coverage, user-confirmed full automated verification, completed manual checks, and explicit deferrals. Stage 13 is approved on that basis. Remaining manual recovery/editor/platform checks are deferred to daily use by user approval, not claimed passed; repeated clean-checkout provenance remains unrecorded and outstanding for release readiness.

- [x] Complete fake-API wiring scenarios for config, workspaces, path gates, bash, files, event hooks, reload, and shutdown.
- [ ] Verify branch restoration, malformed config, missing programs, non-UI behavior, and all cleanup paths.
- [ ] Check for leaked children, temporary files, file sessions, post-tool actions, and reservations.
- [x] Maintain a concise manual Pi checklist and convert discovered lifecycle behavior into focused automated regression tests.
- [ ] Run the complete verification suite repeatedly from a clean checkout.

Do not add fake model APIs, scripted providers, RPC agent-loop emulation, or automated model integration infrastructure.

**Review checkpoint:** Approved by the user after full automated verification and the recorded manual subset, with remaining manual checks explicitly deferred and best-effort recovery limitations acknowledged. Unchecked evidence items remain outstanding rather than implicitly passed.

---

## 10. Delivery Order and Review Gates

The document is organized by responsibility; implementation follows the dependency order below. Each link leads to the owning specification and its completion evidence, not a second checklist. Stage numbers preserve the original review sequence and are distinct from document section numbers.

| Stage | Owning specification and checkpoint | Prerequisite |
| --- | --- | --- |
| 1 | [Compatibility baseline](#41-pi-guarantees-to-verify-and-use) | None |
| 2 | [Configuration foundation](#3-toml-contract) | Baseline |
| 3 | [Command execution and config editing](#35-config-editing) | Configuration |
| 4 | [Workspace persistence and commands](#53-snapshot-persistence) | Configured commands |
| 5 | [Workspace resources and context](#55-resource-and-rules-loading) | Workspace state |
| 6 | [Path permission gates](#51-path-tools-and-normalization) | Workspace boundaries |
| 7 | [Basic review policies, feedback, and reservations](#62-basic-review-composition) | Path gate and process boundary |
| 8 | [Review race coordinator](#64-race-coordinator) | Immediate decisions and process cancellation |
| 9 | [External Bash review](#68-bash-tool_call) | Coordinator |
| 10 | [Pi-powered file preview](#65-pi-powered-file-preview) | Canonical paths and snapshot classification |
| 11 | [External file review and post-tool actions](#66-file-tool_call) | Preview restoration and coordinator |
| 12 | [Event hooks](#7-event-hooks) | Reviewed event timing |
| 13 | [Regression and recovery](#96-extension-wiring-and-manual-pi-checks) | Complete feature wiring |
| 14 | [Documentation and release](#12-known-limitations-and-documentation) | Regression evidence |

Stages 1–13 are approved, with Stage 13's documented verification deferrals. Stage 14, documentation and release readiness, is in progress. Later-stage dependency leaves may be implemented early when explicitly agreed; that does not complete their parent checkpoint.

---

## 11. Acceptance Matrix

| Situation                             | Expected result                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| No config, path tool inside workspace | normal Pi behavior except write/edit default prompt               |
| Path tool outside workspace           | one-call Allow/Deny gate first                                    |
| No config, `write`/`edit`             | Accept/Reject plus optional feedback                              |
| No config, `bash`                     | normal Pi behavior                                                |
| Explicit `allow`/`deny`               | immediate decision without permission notification                |
| Explicit `prompt`                     | Pi prompt and permission notification                             |
| External handler with UI              | editor/Pi decision coordination                                   |
| External handler without UI           | editor is sole decision source; failure blocks                    |
| Existing file external review         | Pi preview on actual target with original temp file               |
| New file external review              | Pi preview on actual target                                       |
| User changes reviewed file            | restore, run normal tool, apply reviewed content in `tool_result` |
| User changes bash command             | execute non-empty edited input; annotate exact command in result   |
| Acceptance feedback                   | normal tool runs and feedback appears in result                   |
| Original file tool fails after review | still attempt reviewed content; preserve original error           |
| Concurrent same-path mutation         | second call blocked with retry guidance                           |
| Invalid config/regex                  | current warning on each load and safe fallback                    |
| Resume/tree/fork active branch        | nearest valid workspace snapshot on active branch restored        |
| Add/remove workspace                  | snapshot persisted, reload performed, resources refreshed         |
| Open all workspaces                   | one shared group ID; independent best-effort opener commands      |
| Event-hook command fails              | no effect on Pi flow                                              |

---

## 12. Known Limitations and Documentation

### 12.1 Non-goals and limitations

- Pi only; no other harness/backend support initially.
- Not a sandbox.
- Bash and custom tools are not workspace-contained.
- Arbitrary custom tools are not path-gated without explicit adapters.
- No workspace-local extension config.
- No workspace extension loading.
- Additional workspaces use one selected root instruction file plus optional `.pi/APPEND_SYSTEM.md`; no recursive rules discovery.
- No automatic project-root inference or overlap collapsing.
- No execution of empty editor content or unsuccessful editor results; successful edited Bash input runs only when a configured waiting editor is saved and closed.
- External editors must wait; detached launchers weaken cancellation guarantees.
- External file preview assumes Pi's local built-in write/edit implementations.
- Path checks cannot prevent every TOCTOU/symlink race.
- Prompt-required actions fail closed without Pi UI.

### 12.2 README

README should document:

- Pi-only scope and installation;
- config path and `/tc:edit-config`;
- high-level rule semantics and defaults, but not the complete schema;
- command reference;
- workspace persistence/trust/gating;
- skills, prompts, root instruction precedence, and `.pi/APPEND_SYSTEM.md` loading;
- recommendation to launch Pi from the project intended as the primary workspace;
- editor wait requirement;
- permission-gate-not-sandbox warning;
- built-in/local preview assumptions;
- troubleshooting and known limitations;
- statement that the generated commented TOML is the complete config reference.

Do not duplicate the full schema in README.

#### Implementation checklist — Documentation and Release Readiness

- [x] Expand README with Pi-only checkout installation, effective `PI_CODING_AGENT_DIR` config location, high-level config behavior, commands, defaults, and troubleshooting.
- [x] Document workspace trust/gating plus skills, prompts, root instruction precedence, and `.pi/APPEND_SYSTEM.md` loading.
- [x] Recommend launching Pi from the project intended as the primary workspace and explain Pi's native cwd resource loading.
- [x] Document editor wait requirements, non-UI behavior, built-in/local preview assumptions, the not-a-sandbox limitation, filesystem TOCTOU races, and best-effort mid-tool-call reload/recovery behavior.
- [x] Point users to the generated commented TOML for the complete schema; do not duplicate it in README.
- [ ] Verify pnpm package metadata, published files, and clean installation.
- [ ] Run typechecking, all tests, and final manual Pi checks with supported editors.
- [ ] Optionally install a small tool-capable Gemma 3 model through Ollama for final manual smoke testing.
- [ ] Record future ideas separately from initial Pi-only scope.

Compatibility reconciliation remains open: the original Pi 0.84.x baseline differs from the current resolved Pi 1.0.2 dependency and the user's broad runtime description. README records that distinction without expanding the supported range. Package metadata/published-file checks and clean-install evidence remain pending; package manifests and pnpm files are off-limits to the assistant under the working agreement.

**Final review checkpoint:** Approve documentation, package contents, known limitations, and release readiness.

---

## 13. Instructions for Implementing Agents

1. Read this file and `working_agreement.md` completely; use the embedded feature checklists as the only completion record.
2. Recheck installed Pi docs, public exports, built-in tools, session branching, resources, and extension events before relying on an API assumption.
3. Use pnpm only. Explain commands and obtain review before running package-management or mutating setup commands.
4. Implement one delivery stage at a time, using focused modules and tests.
5. Follow the delivery order in Section 10 and stop at each embedded review checkpoint.
6. Prefer pure functions and injected boundaries.
7. Test async review flows as explicit typed state transitions with one cleanup owner.
8. Do not build a custom write/edit proposal engine, fake model API, or full agent-loop simulator.
9. Ask the user to verify new Pi behavior and run checks at each checkpoint; turn discoveries into focused regression tests. Do not run tests without explicit permission.

The highest-risk areas are process cancellation, temporary mutation/restoration of actual files, deferred post-tool actions, branch-sensitive workspace state, and shutdown cleanup. Keep ownership explicit and cleanup idempotent.
