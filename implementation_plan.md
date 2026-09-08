# Pi Teleprompt Commentary — Implementation Plan

## 1. Purpose and Scope

Pi Teleprompt Commentary is a **Pi-only extension** with three responsibilities:

1. **Review agent tool calls**
   - Intercept Pi's built-in path tools and agent `bash` calls at `tool_call` preflight.
   - Resolve user-defined policies that allow, deny, prompt, or launch an external review command.
   - Let users revise proposed file contents or suggest a replacement shell command.

2. **Attach multiple workspaces to one Pi session**
   - Maintain an explicit, session-scoped list of workspace directories.
   - Tell the agent which workspaces belong to the session.
   - Gate predictable path tools when they access paths outside those workspaces.
   - Load skills, prompts, and one short rules file from each workspace.

3. **Run external handlers**
   - Open files, diffs, workspaces, and the extension config.
   - Send best-effort desktop notifications.

This extension is a **permission and review aid, not a security sandbox**. `bash`, custom tools, symlink races, and external programs can bypass its path checks. The initial implementation supports Pi only; it will not include abstractions for OpenClaw or other agent harnesses.

---

## 2. Settled Product Behavior

### 2.1 Global configuration

The extension has one optional global TOML file:

```text
~/.pi/agent/teleprompt-commentary.toml
```

There are no workspace-local extension configs and no JSON config format.

Config loading behavior:

- Missing config means built-in defaults and no warning.
- Parse and validate once during `session_start` so users see errors early.
- Reread and validate on every affected action so edits take effect without `/reload`.
- Invalid TOML, invalid regexes, and schema errors produce non-blocking warnings and safe fallback behavior.
- Deduplicate repeated identical warnings.
- Generate a fully commented starter config from `/tc:edit-config` when the file does not exist.
- The generated TOML, not README, is the complete configuration reference.

### 2.2 Review actions and defaults

File and command review rules may resolve to:

- `"allow"`: proceed without extension review;
- `"deny"`: block immediately;
- `"prompt"`: use Pi's Accept/Reject prompt with optional feedback;
- a command array: launch an external handler and, when Pi has UI, race it against the Pi prompt.

Defaults when no rule matches:

| Tool or situation | Default |
|---|---|
| `write` | `prompt` |
| `edit` | `prompt` |
| `bash` | normal Pi behavior |
| `read`, `grep`, `find`, `ls` inside a workspace | normal Pi behavior |
| Supported path tool outside all workspaces | one-call workspace permission prompt, then normal policy flow |

Explicit `allow` and `deny` do not emit a `tool_permission_request` notification. Prompt and external-handler flows do.

### 2.3 Existing and new files

- `diff_editor` applies only when a proposed operation targets an existing file.
- `new_file_editor` applies only when a proposed operation targets a new file.
- They are mutually exclusive and do not fall back to one another.
- `edit` normally uses `diff_editor` because Pi's built-in edit requires an existing file.
- `write` chooses based on existence when preflight starts.

### 2.4 External file review

For a matching external file handler:

1. Reserve the canonical target path for this tool call.
2. Snapshot the pre-review filesystem state.
3. Invoke Pi's actual built-in `write` or `edit` tool definition with the original arguments. This writes Pi's exact proposal to the actual target.
4. For an existing file, pass a temporary original-content file and the actual proposed target to `diff_editor`.
5. For a new file, pass the actual proposed target to `new_file_editor`.
6. If Pi has UI, launch the external editor and Pi prompt concurrently. Otherwise, use the configured external editor as the only decision source.
7. Capture the decision or user-reviewed contents.
8. Restore the pre-review filesystem state before the original Pi tool call proceeds.
9. Let Pi run the original tool normally.
10. Apply any captured reviewed contents afterward in `tool_result` and annotate the result concisely.

Outcomes with Pi UI:

- **Pi accepts first:** cancel/ignore the editor, discard unconfirmed editor changes, restore, and allow the original tool. Preserve optional acceptance feedback for the tool result.
- **Pi rejects first:** cancel the editor, restore, and block with optional feedback.
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
- Changed successful editor exit blocks the original command and returns the edited command as a suggestion to the agent.
- Never execute the edited command automatically.

### 2.6 Prompt feedback

The review prompt is two-step:

1. Choose `Accept` or `Reject`.
2. Enter optional feedback for either decision.

```ts
type PromptDecision =
  | { type: "accept"; feedback?: string }
  | { type: "reject"; feedback?: string }
  | { type: "cancel" }
  | { type: "aborted" };
```

- Rejection feedback is included in the tool block reason.
- Acceptance feedback is deferred and appended to the eventual tool result.
- Cancel is treated as rejection.
- Programmatic abort is distinct from user cancellation.

### 2.7 Non-UI modes

- Workspace permission prompts fail closed without UI.
- `prompt` actions fail closed without UI.
- `allow` and `deny` retain their normal meanings.
- Explicit command-array handlers may run without Pi UI because the external program is itself a user interface.
- An external-handler failure without Pi UI blocks the operation.

### 2.8 Workspaces

- Workspaces are session-scoped and persisted as full snapshots in Pi custom entries.
- The cwd is not implicitly permitted.
- An empty workspace list means all supported path-tool calls require one-call approval.
- Adding a workspace implies trust in its resources and rules.
- One-call outside-workspace approval does not alter the stored workspace list.
- Canonical exact duplicates are rejected/no-op with an informational message.
- Preserve user order.
- Preserve parent/child and other overlapping workspace roots; do not infer or collapse project relationships.
- Workspace listings show paths only.

Workspace resources:

- `<workspace>/.pi/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.pi/prompts`
- one optional short rules file: `<workspace>/.pi/AGENTS.md`

Skills and prompts are contributed through `resources_discover`. Rules are reread and appended to the system prompt during `before_agent_start`, with clear path provenance. Rules are not recursively discovered and are not stored as session messages. Missing rule files are ignored; read failures warn non-blockingly.

Never load workspace extensions. README must explain all loaded resources, emphasize keeping `.pi/AGENTS.md` short, and recommend launching Pi from the home directory to reduce unintended native cwd/project resource loading. The extension cannot suppress resources Pi discovers independently from its cwd.

### 2.9 Commands

Register:

- `/tc:edit-config [editor shell command...]`
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

Every handler category is an ordered array of rule objects. Rule conditions are keys prefixed with `var:`. The `handler` field contains the selected action or command.

```toml
[[handlers.new_file_editor]]
"var:new_file_path" = '\.md$'
handler = "prompt"

[[handlers.new_file_editor]]
"var:new_file_path" = '^/home/user/important/.*'
handler = [
  "code",
  "--wait",
  { var = "new_file_path" }
]
```

Rules are evaluated in declaration order. All conditions in one rule must match. The final matching rule supplies the handler. An empty rule array is valid and behaves like an omitted category.

The same last-match-wins selection applies to every category, including notifications. Users who need additive notifications, multiple editors, pipelines, or sequential programs should provide a wrapper script as the executable.

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
  | "message_title"
  | "message_body";

interface Placeholder {
  var: VariableName;
  prepend?: string;
  append?: string;
}

type CommandToken = string | Placeholder;
type Command = [string, ...CommandToken[]];
type Decision = "allow" | "deny" | "prompt";
```

Placeholder expansion produces exactly one argv element:

```text
prepend + resolved variable value + append
```

Do not split, interpolate, or reparse the result. Configured handler commands execute directly with `shell: false`. A user who wants shell behavior may explicitly configure `sh`, `bash`, or another shell as the executable and define quoting in their script/command.

Validate variables per handler context:

| Handler | Available variables | Allowed handler values |
|---|---|---|
| `configuration_editor` | `config_file_path` | command only |
| `notifier` | `message_title`, `message_body` | command only |
| `workspace_opener` | `directory_path`, `group_id` | command only |
| `diff_editor` | `old_content_file_path`, `new_content_file_path` | decision or command |
| `new_file_editor` | `new_file_path` | decision or command |
| `command_editor` | `command_file_path`, `command_string` | decision or command |

Unknown handler categories, variables, fields, and actions should produce useful validation errors. Unknown unrelated top-level keys may warn rather than fail to preserve forward compatibility.

### 3.4 Representative config

The generated starter file should contain a complete, commented reference. This is only a representative active example:

```toml
[[handlers.configuration_editor]]
"var:config_file_path" = '\.toml$'
handler = ["code", "--wait", { var = "config_file_path" }]

[[handlers.notifier]]
event = "assistant_message_end"
handler = ["notify-send", { var = "message_title" }, { var = "message_body" }]

[[handlers.notifier]]
event = "tool_permission_request"
handler = ["notify-send", { var = "message_title" }, { var = "message_body" }]

[[handlers.notifier]]
event = "agent_settled"
handler = ["notify-send", { var = "message_title" }, { var = "message_body" }]

[[handlers.workspace_opener]]
"var:directory_path" = '.*'
handler = [
  "code",
  "--new-window",
  { var = "directory_path" },
  { var = "group_id", prepend = "--group=" }
]

[[handlers.diff_editor]]
"var:new_content_file_path" = '\.md$'
handler = [
  "code",
  "--wait",
  "--diff",
  { var = "old_content_file_path" },
  { var = "new_content_file_path" }
]

[[handlers.new_file_editor]]
"var:new_file_path" = '\.md$'
handler = ["code", "--wait", { var = "new_file_path" }]

[[handlers.command_editor]]
"var:command_string" = '^rm\s+-rf'
handler = "prompt"
```

Notifier rules require an exact `event` field. Supported initial events:

- `assistant_message_end`
- `tool_permission_request`
- `agent_settled`

Use the same last-match-wins behavior for multiple matching notifier rules.

### 3.5 Config editing

`/tc:edit-config [editor shell command...]`:

1. Create the global config directory if necessary.
2. Atomically create the fully commented starter TOML when absent.
3. Resolve the editor in this order:
   1. shell command supplied to `/tc:edit-config`;
   2. last matching `configuration_editor` rule;
   3. `$EDITOR` as a user-controlled shell command;
   4. direct `vi` fallback.
4. Pass `config_file_path` safely as a positional argument or environment variable rather than interpolating it into shell source.
5. Configured command arrays remain direct argv execution; only the user-supplied override and `$EDITOR` intentionally use shell semantics.
6. Try the next fallback after a startup/failure outcome where doing so is meaningful.
7. Reparse after the editor exits and show validation warnings.
8. Do not persist a one-off editor command.

No argv-tokenizer dependency is needed solely for editor overrides.

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

### 4.2 Suggested modules

```text
extensions/
  index.ts                    # Extension factory and event registration
  config/
    schema.ts                 # Zod schemas and inferred config types
    loader.ts                 # TOML startup/on-demand loading and warning dedupe
    regex.ts                  # Regex specification parsing and matching
    rules.ts                  # Generic ordered rule resolution
    starter.ts                # Canonical commented TOML template
  handlers/
    variables.ts              # Runtime variable contexts and placeholder expansion
    process.ts                # Direct command execution and cancellation
    configuration-editor.ts   # Shell/direct editor fallback selection
    notifications.ts          # Best-effort notifier dispatch
    workspace-opener.ts       # Single/group workspace opening
  workspaces/
    state.ts                  # Snapshot state and duplicate handling
    persistence.ts            # Branch-aware custom-entry restoration
    paths.ts                  # Canonicalization and containment
    resources.ts              # Skills/prompts/rules discovery
    commands.ts               # tc:workspace-* commands
  review/
    prompts.ts                # Pi decisions and optional feedback
    coordinator.ts            # Prompt/external-process state machine
    reservations.ts           # In-memory same-path reservations
    file-session.ts           # Snapshot, preview, restore, cleanup
    pi-preview.ts             # Actual Pi write/edit adapters
    bash-review.ts            # Command temp-file review
    post-tool-actions.ts       # Deferred reviewed content and feedback
  messages.ts                 # Concise user/agent-facing wording

tests/
  config/
  handlers/
  workspaces/
  review/
  wiring/
  compatibility/
```

Keep public interfaces narrow. Inject filesystem, process, UI, clock/UUID, and Pi-facing operations so modules are deterministic under test.

### 4.3 Runtime state

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

interface RuntimeState {
  workspaces: string[];
  postToolActions: Map<string, PostToolAction[]>; // toolCallId -> deferred actions
  pathReservations: PathReservations;
  warnedConfigErrors: Set<string>;
  activeFileSessions: Map<string, FileReviewSession>;
  spawnedChildren: Set<ChildProcess>;
}
```

The review itself is not pending after `tool_call`; only explicit post-tool actions are deferred. A short-lived `FileReviewSession` owns original bytes/existence, temporary paths, child process, and restoration metadata. It must be cleaned before the original Pi tool executes.

On `session_shutdown`:

- abort/terminate tracked handlers;
- restore in-flight file sessions;
- remove temporary resources;
- clear post-tool actions and reservations.

Cleanup must be idempotent.

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

| Tool | Path |
|---|---|
| `read` | `input.path` |
| `write` | `input.path` |
| `edit` | `input.path` |
| `grep` | `input.path`, or cwd when omitted |
| `find` | `input.path`, or cwd when omitted |
| `ls` | `input.path`, or cwd when omitted |

Do not infer path fields on arbitrary custom tools. Implement extraction as `string[]` so future known multi-path tools can be added safely.

Mirror Pi path behavior:

1. strip accepted leading `@`;
2. expand `~`;
3. resolve relative paths from `ctx.cwd`;
4. normalize `.`/`..` and separators;
5. `realpath` existing targets;
6. for missing targets, realpath the nearest existing ancestor and append the missing suffix;
7. canonicalize workspace roots;
8. test containment with `path.relative`, never string prefixes.

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

### 5.3 Snapshot persistence

```ts
const WORKSPACE_ENTRY = "teleprompt-commentary.workspaces";

interface WorkspaceSnapshotV1 {
  version: 1;
  paths: string[];
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

- `workspace-add`: argument or input prompt; require an existing directory; canonicalize; reject exact canonical duplicate; preserve overlaps/order; snapshot; `await ctx.reload(); return`.
- `workspace-remove`: exact argument or stored-path selector; snapshot; reload.
- `workspace-list`: show ordered paths or a clear empty state.
- `workspace-open`: argument or selector; generate UUID; resolve and directly spawn the last matching opener.
- `workspaces-open`: no arguments; one UUID for all paths; resolve each independently and start the resulting commands as one best-effort group.

### 5.5 Resource and rules loading

During `resources_discover`, return existing directories only:

- `<workspace>/.pi/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.pi/prompts`

During `before_agent_start`:

- list workspace paths and permission behavior;
- state that cwd is not implicitly allowed;
- state that `bash` is not workspace-gated;
- instruct the agent not to issue parallel same-path mutations;
- reread each `<workspace>/.pi/AGENTS.md` and append it with workspace/path attribution;
- keep missing files silent and warn on read failures.

Do not load themes, workspace extension config, context-file trees, or workspace extensions.

---

## 6. Review and Execution Pipelines

### 6.1 Generic rule resolution

For an action:

1. Load config on demand.
2. Build the handler-specific variable context.
3. Filter rules by exact event where applicable and by all regex conditions.
4. Select the final matching rule.
5. Apply the category default when none matches.
6. Execute only the selected handler.

### 6.2 Pi prompt

- Emit permission notification before interactive review.
- Select Accept/Reject.
- Ask for optional feedback in either case.
- Use an `AbortController` so an editor result can close the prompt.
- Fail closed when the prompt is required but UI is unavailable.

### 6.3 Process helper

Configured commands use `spawn(executable, args, { shell: false })` and support:

- startup/completion result;
- cancellation;
- runtime child tracking;
- bounded termination attempts;
- idempotent cleanup.

Begin with Node's portable child termination behavior. Add platform-specific termination only if tests demonstrate a need. Document that killing launcher processes cannot reliably stop detached GUI editors. Waiting editor flags remain the user's responsibility.

Notifier failures are always swallowed. Review-handler failures follow UI/non-UI behavior described earlier.

### 6.4 Race coordinator

A naive `Promise.race` is insufficient because it does not cancel the loser and editor failure is non-decisive while a Pi prompt remains available.

The coordinator must:

- race only decisive outcomes;
- abort a stale Pi prompt when the editor decides;
- terminate and await the editor when Pi decides;
- keep the prompt alive after editor startup/nonzero failure;
- settle exactly once;
- expose deterministic fake process/UI interfaces for tests.

### 6.5 Pi-powered file preview

Production preview adapters call Pi's actual public built-in definitions with the original input and current cwd/context:

```ts
createWriteToolDefinition(ctx.cwd)
createEditToolDefinition(ctx.cwd)
```

The snapshot is taken first; the real Pi definition writes the proposal to the actual target. No custom write/edit proposal implementation or parity clone is needed.

If preview execution fails:

- restore state;
- do not present a misleading external preview;
- allow the normal original tool execution to report its native error, unless another independent gate already denied it.

Tests should directly run these production adapters against temporary fixtures and verify they use Pi's actual behavior.

### 6.6 File `tool_call`

```text
normalize target
acquire path reservation or block
run workspace gate
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

### 6.8 Bash `tool_call`

```text
read raw command
load config and resolve command_editor
no match -> preserve normal Pi behavior
allow -> proceed
deny -> block
prompt -> Accept/Reject + optional feedback
command -> write command temp file and coordinate editor/prompt
```

Changed external command content blocks with a bounded suggestion. Clean temporary data on every path. Acceptance feedback becomes a post-tool action; rejection feedback becomes the block reason.

---

## 7. Notifications

Notifier rule objects include an exact `event` field and use normal last-match-wins resolution.

Initial events and predictable extension-authored values:

| Event | `message_title` | `message_body` |
|---|---|---|
| `assistant_message_end` | `Pi` | `Assistant message completed.` |
| `tool_permission_request` | `Pi permission request` | `Review required for <known tool name>.` |
| `agent_settled` | `Pi` | `Agent is ready for input.` |

Internally, `assistant_message_end` is dispatched from Pi's `message_end` only when `message.role === "assistant"`.

Do not include model output, command strings, file contents, arbitrary paths, or user feedback in initial notification variables. Because content is predictable and bounded, do not add sanitization/truncation machinery initially.

Load config on demand, expand placeholders, spawn directly, and catch all notifier failures without affecting Pi.

---

## 8. Dependencies and Package Setup

Expected runtime dependencies:

- a maintained ESM-compatible TOML parser;
- Zod.

JavaScript `RegExp` replaces minimatch. User-supplied config-editor commands intentionally use a shell, so no argv tokenizer is required for them.

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
- Given the same error repeats, the user is not spammed with duplicate warnings.

### 9.2 Workspace/path scenarios

- Given `/work/app` is allowed, `/work/app/file` is allowed but `/work/application/file` and `/work` are not.
- Given an existing symlink or missing path below a symlink ancestor, canonical containment prevents an apparent workspace escape.
- Given cwd is omitted from `grep`, `find`, or `ls`, cwd is checked and prompts unless explicitly added.
- Given no workspaces, every supported path tool prompts.
- Given a canonical duplicate workspace, add is a no-op; given parent/child roots, both remain.
- Given snapshots on different session branches, restoration chooses the latest snapshot nearest the active leaf, including a valid empty snapshot.
- Given workspace add/remove, the snapshot is persisted before reload and resources refresh afterward.
- Given workspace resources, only native skill/prompt directories and `.pi/AGENTS.md` behavior are contributed; extensions are not loaded.
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
- Given any failure/cancel path, temporary files, sessions, actions, and reservations are cleaned exactly once.

### 9.5 Bash and notification scenarios

- Given no command rule, agent bash is untouched.
- Given a changed external command, the original is blocked and the suggestion is returned but never executed.
- Given prompt acceptance with feedback, the command runs and feedback appears in its result.
- Given user `!`/`!!`, no interception occurs.
- Given each notification event, only the final matching notifier runs with predictable constructed text.
- Given explicit allow/deny or normal no-op, no permission notification runs.
- Given notifier process failure, Pi behavior is unchanged.

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

---

## 10. Implementation Phases

### Phase 0 — Compatibility baseline

Establish pnpm tooling, modular layout, supported Pi version, extension registration tests, and manual loading/command checks.

### Phase 1 — Configuration

Implement TOML schema/loading, regex conditions, ordered last-match resolution, placeholders, warning dedupe, starter config, and configuration editing.

### Phase 2 — Workspaces

Implement branch-aware snapshots, canonical paths, duplicate handling, workspace commands, single/group openers, skills/prompts, and short rules loading.

### Phase 3 — Workspace permission gates

Add typed built-in path adapters, one-call Allow/Deny behavior, no-UI failure, and permission notifications.

### Phase 4 — Basic review policies

Implement allow/deny/prompt defaults, optional feedback for both outcomes, post-tool feedback actions, and path reservations.

### Phase 5 — Process and race coordination

Implement direct process execution, cancellation, explicit coordinator states, and shutdown cleanup.

### Phase 6 — Bash external review

Implement command temp files, changed-command suggestions, external-only non-UI behavior, and complete cleanup.

### Phase 7 — Pi-powered file review

Implement snapshots, real Pi preview adapters, actual-target editor flow, restoration, post-tool reviewed-content application, and same-path conflict handling.

### Phase 8 — Notifications and UX

Implement predictable event notifications, polish wording/warnings, and exercise manual TUI behavior.

### Phase 9 — Release hardening

Complete documentation, package verification, clean-install checks, known limitations, optional manual Ollama/Gemma testing, and final manual Pi checks.

---

## 11. Acceptance Matrix

| Situation | Expected result |
|---|---|
| No config, path tool inside workspace | normal Pi behavior except write/edit default prompt |
| Path tool outside workspace | one-call Allow/Deny gate first |
| No config, `write`/`edit` | Accept/Reject plus optional feedback |
| No config, `bash` | normal Pi behavior |
| Explicit `allow`/`deny` | immediate decision without permission notification |
| Explicit `prompt` | Pi prompt and permission notification |
| External handler with UI | editor/Pi decision coordination |
| External handler without UI | editor is sole decision source; failure blocks |
| Existing file external review | Pi preview on actual target with original temp file |
| New file external review | Pi preview on actual target |
| User changes reviewed file | restore, run normal tool, apply reviewed content in `tool_result` |
| User changes bash command | block original and return suggestion |
| Acceptance feedback | normal tool runs and feedback appears in result |
| Original file tool fails after review | still attempt reviewed content; preserve original error |
| Concurrent same-path mutation | second call blocked with retry guidance |
| Invalid config/regex | deduplicated warning and safe fallback |
| Resume/tree/fork active branch | nearest valid workspace snapshot on active branch restored |
| Add/remove workspace | snapshot persisted, reload performed, resources refreshed |
| Open all workspaces | one shared group ID; independent best-effort opener commands |
| Notification fails | no effect on Pi flow |

---

## 12. Known Limitations and Documentation

### 12.1 Non-goals and limitations

- Pi only; no other harness/backend support initially.
- Not a sandbox.
- Bash and custom tools are not workspace-contained.
- Arbitrary custom tools are not path-gated without explicit adapters.
- No workspace-local extension config.
- No workspace extension loading.
- One root `.pi/AGENTS.md` per workspace; no recursive rules discovery.
- No automatic project-root inference or overlap collapsing.
- No automatic execution of edited bash suggestions.
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
- skills, prompts, and short `.pi/AGENTS.md` loading;
- recommendation to launch Pi from home to avoid unintended cwd resources;
- editor wait requirement;
- permission-gate-not-sandbox warning;
- built-in/local preview assumptions;
- troubleshooting and known limitations;
- statement that the generated commented TOML is the complete config reference.

Do not duplicate the full schema in README.

---

## 13. Instructions for Implementing Agents

1. Read this file and `task.md` completely.
2. Recheck installed Pi docs, public exports, built-in tools, session branching, resources, and extension events before relying on an API assumption.
3. Use pnpm only. Explain commands and obtain review before running package-management or mutating setup commands.
4. Implement one task section at a time, with focused modules and tests.
5. Stop at every review checkpoint in `task.md`.
6. Prefer pure functions and injected boundaries.
7. Test async review flows as explicit typed state transitions with one cleanup owner.
8. Do not build a custom write/edit proposal engine, fake model API, or full agent-loop simulator.
9. Manually exercise new Pi behavior at each checkpoint and convert discoveries into focused regression tests.

The highest-risk areas are process cancellation, temporary mutation/restoration of actual files, deferred post-tool actions, branch-sensitive workspace state, and shutdown cleanup. Keep ownership explicit and cleanup idempotent.
