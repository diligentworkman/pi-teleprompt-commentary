# Pi Teleprompt Commentary — Task List

This checklist turns [`implementation_plan.md`](./implementation_plan.md) into small, reviewable stages.

## Working Agreement

- Complete one section at a time.
- Stop at every **Review checkpoint** until the work is approved.
- Keep modules focused, interfaces narrow, and external boundaries injectable.
- Add tests with every functional change and run all accumulated checks before review.
- Use pnpm only. Explain package-management and mutating setup commands before running them.
- Treat `implementation_plan.md` as the product/architecture specification and this file as the execution order.
- Record and approve intentional deviations before implementing them.

---

## 1. Project and Pi Compatibility Baseline

- [x] Confirm the supported Pi/Node versions, required public exports, event ordering, and `tc:*` command naming.
- [x] Establish the extension entry point and modular source/test layout.
- [x] Configure pnpm-based TypeScript and test tooling for nested modules.
- [x] Add a fake-API extension registration test covering the entry point and namespaced commands.
- [x] Add scripts for unit tests, wiring tests, typechecking, and the complete verification suite.
- [x] Manually load the minimal extension in Pi and invoke a `tc:*` command.
- [x] Run all checks and document compatibility assumptions.

**Review checkpoint:** Approve structure, tooling, and Pi assumptions before adding runtime behavior.

---

## 2. Configuration Foundation

- [x] Select and add the TOML parser and Zod through pnpm.
- [x] Implement schemas for ordered handler/hook action rules, context-specific variables, regex specifications, commands, and placeholders.
- [x] Implement startup/on-demand TOML loading, safe fallback, and current warning reporting (warning deduplication removed; see `plan_modifications.md`).
- [x] Implement JavaScript-regex condition matching and generic last-match-wins rule resolution.
- [x] Implement one-argument placeholder expansion with optional `prepend`/`append`.
- [x] Add plain behavioral tests for malformed config, regex flags, multiple conditions, rule precedence, invalid variables/actions, and live config changes.
- [x] Run typechecking and all tests.

**Review checkpoint:** Approve the config model and rule semantics before connecting handlers.

---

## 3. Command Execution and Config Editing

- [x] Implement a direct argv process module with tracked completion, cancellation, and idempotent cleanup.
- [x] Keep config editor execution direct-argv only; do not interpret command arguments or environment variables as shell source (see `plan_modifications.md`).
- [x] Implement the complete commented starter TOML as the canonical config reference.
- [x] Implement argument-free `/tc:edit-config` at the effective `PI_CODING_AGENT_DIR` extension path, with configured-handler selection, Pi multiline-editor fallback, and a clear non-UI outcome.
- [x] Revalidate config after editing and warn non-blockingly.
- [x] Test argument integrity, process outcomes, cancellation, starter creation, configured editor selection, Pi-editor save/cancel behavior, and non-UI outcomes.
- [x] Manually inspect the generated config and edit it through Pi.
- [x] Run typechecking and all tests.
- [x] On configured-editor spawn failure, nonzero exit, or signal termination, warn, reread the current config file, and open Pi's multiline editor when UI is available; preserve clean-exit and non-UI behavior (see `plan_modifications.md`).
- [x] Test all three failure outcomes, warning-before-fallback ordering, rereading externally changed content, Pi-editor save/cancel behavior, revalidation, clean-exit behavior, and no-UI behavior; update existing failure expectations.
- [x] Manually verify configured-editor failure recovery, then rerun typechecking and all tests.

**Review checkpoint:** Approve process behavior and the generated configuration reference.

---

## 4. Workspace State, Persistence, and Commands

- [ ] Treat canonical cwd as the automatically permitted primary workspace and implement canonical ordered additional-workspace state with exact-duplicate rejection and preserved overlaps (see `plan_modifications.md`).
- [ ] Implement versioned full snapshots and active-branch restoration from the nearest valid entry.
- [ ] Implement `/tc:workspace-add`, `/tc:workspace-remove`, and `/tc:workspace-list` with primary/additional workspace wording and separate listing.
- [ ] Persist snapshots before resource reloads and treat reload as terminal to the command handler.
- [ ] Implement `/tc:workspace-open` and `/tc:workspaces-open` with per-invocation group IDs and generic rule variables.
- [ ] Test primary/additional separation, duplicates, parent/child roots, removal to empty, branch divergence, argument/input/select flows, group IDs, and partial opener failures.
- [ ] Manually exercise every workspace command and session resume/tree behavior.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve workspace state, branching behavior, and command UX.

---

## 5. Workspace Resources, Rules, and Agent Context

- [ ] Discover existing `.pi/skills`, `.agents/skills`, and `.pi/prompts` directories for Pi.
- [ ] For additional workspaces, load root instructions with `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` precedence plus `.pi/APPEND_SYSTEM.md`, and reread them before each agent run (see `plan_modifications.md`).
- [ ] Append attributed, concise workspace boundaries/rules and same-path mutation guidance to the system prompt.
- [ ] Let Pi own primary-workspace instructions; never duplicate them or load workspace extensions, recursive rules, `.pi/SYSTEM.md`, or unsupported resources.
- [ ] Test resource filtering/order, instruction precedence, primary-workspace exclusion, missing/read-failing files, reload, and generated system-prompt text.
- [ ] Manually verify skill/prompt discovery and workspace rules in Pi.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve loaded resources and exact agent-facing context.

---

## 6. Path Permission Gates

- [ ] Implement Pi-compatible canonical path resolution and containment checks, including missing targets below symlinks.
- [ ] Add typed path extractors for `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- [ ] Implement the one-call outside-primary-and-additional-workspaces Allow/Deny gate before file policy resolution.
- [ ] Fail closed when the workspace gate requires unavailable UI.
- [ ] Test descendants, parents, sibling prefixes, automatic primary-workspace permission, empty additional workspaces, symlinks, and future multi-path extraction.
- [ ] Add extension wiring tests for every supported built-in path tool.
- [ ] Manually verify inside/outside path calls in Pi.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve path semantics and the permission-gate UX.

---

## 7. Basic Review Policies, Feedback, and Reservations

- [ ] Implement Accept/Reject prompts with optional feedback for either decision.
- [ ] Implement `allow`, `deny`, and `prompt` for file/command handlers with agreed defaults.
- [ ] Implement typed post-tool actions for acceptance feedback.
- [ ] Implement in-memory canonical path reservations for every `write`/`edit`, with explicit same-path conflict blocking.
- [ ] Add defensive release/cleanup across rejection, result, execution end, and shutdown.
- [ ] Test the decision matrix, feedback delivery, workspace-before-review ordering, reservation conflicts, and no-UI prompt behavior.
- [ ] Manually verify prompts, feedback, and same-path block reasons.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve policies, feedback semantics, and reservation lifecycle before external editors.

---

## 8. Review Race Coordinator

- [ ] Implement one typed coordinator that owns prompt/editor outcomes and settles once.
- [ ] Cancel and await the losing source; keep the prompt active after non-decisive editor failure.
- [ ] Support external-editor-only decisions in non-UI mode.
- [ ] Integrate child tracking and idempotent shutdown cleanup without premature platform-specific backends.
- [ ] Test each completion ordering, late callbacks, startup/nonzero failures, cancellation, and shutdown with fakes.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve the explicit async state transitions and cancellation guarantees independently of file mutation.

---

## 9. External Bash Review

- [ ] Implement secure command temporary-file creation and cleanup under the unique extension runtime temporary directory.
- [ ] Connect `command_editor` command handlers to the race coordinator.
- [ ] Accept unchanged commands, preserve acceptance feedback, and block changed commands with the edited suggestion.
- [ ] Ensure edited suggestions are never executed and user `!`/`!!` remains untouched.
- [ ] Test UI/non-UI outcomes, changed/unchanged content, raw regex matching, bounded feedback, failures, and cleanup.
- [ ] Manually test with a real waiting editor in Pi.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve complete bash-review behavior and agent-facing results.

---

## 10. Pi-Powered File Preview

- [ ] Implement injectable production adapters around Pi's public `createWriteToolDefinition` and `createEditToolDefinition`.
- [ ] Snapshot existing/new target state before invoking the real Pi preview tool.
- [ ] Track created paths/directories and implement reliable, idempotent restoration.
- [ ] Add targeted compatibility tests that run Pi's actual tool definitions against temporary fixtures.
- [ ] Test native preview errors, existing/new targets, metadata/empty contents, and complete restoration.
- [ ] Document local built-in tool assumptions and override/remote limitations.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Inspect real filesystem state and approve preview/restoration before attaching editors.

---

## 11. External File Review and Post-Tool Actions

- [ ] Connect `diff_editor` and `new_file_editor` rules to actual-target Pi preview and the race coordinator.
- [ ] Capture user-reviewed content, restore pre-review state, and register explicit post-tool actions.
- [ ] Apply reviewed content and acceptance feedback in `tool_result` while preserving Pi's original result/error state.
- [ ] Release reservations and clear actions in every success/failure path, with defensive end/shutdown cleanup.
- [ ] Keep agent annotations concise and exclude diffs/full file contents.
- [ ] Test changed/unchanged/empty content, prompt/editor orderings, original-tool failure, post-apply failure, same/unrelated paths, and cleanup exactly once.
- [ ] Add extension wiring scenarios that manually orchestrate `tool_call`, Pi's real tool execution, and `tool_result` without simulating an agent loop.
- [ ] Manually verify existing/new file review with real editors in Pi.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve complete write/edit behavior, filesystem results, and agent-visible annotations.

---

## 12. Notifications

- [ ] Implement best-effort notifier dispatch through normal last-match-wins rules.
- [ ] Add `assistant_message_end`, `tool_permission_request`, and `agent_settled` with predictable extension-authored title/body values.
- [ ] Fire permission notifications only for prompts/external review, not explicit allow/deny or normal no-op.
- [ ] Ensure notifier failures never alter Pi behavior; do not add unnecessary content sanitization initially.
- [ ] Test event filtering, precedence, placeholder expansion, suppression, fixed text, and swallowed failures.
- [ ] Manually test configured desktop notifications.
- [ ] Run typechecking and all tests.

**Review checkpoint:** Approve notification timing, frequency, and wording.

---

## 13. Wiring, Manual Regression, and Failure Recovery

- [ ] Complete fake-API wiring scenarios for config, workspaces, path gates, bash, files, notifications, reload, and shutdown.
- [ ] Verify branch restoration, malformed config, missing programs, non-UI behavior, and all cleanup paths.
- [ ] Check for leaked children, temporary files, file sessions, post-tool actions, and reservations.
- [ ] Maintain a concise manual Pi checklist and convert discovered lifecycle behavior into focused automated regression tests.
- [ ] Run the complete verification suite repeatedly from a clean checkout.

Do not add fake model APIs, scripted providers, RPC agent-loop emulation, or automated model integration infrastructure.

**Review checkpoint:** Approve accumulated automated/manual evidence and remaining limitations.

---

## 14. Documentation and Release Readiness

- [ ] Expand README with Pi-only installation, effective `PI_CODING_AGENT_DIR` config location, high-level config behavior, commands, defaults, and troubleshooting.
- [ ] Document workspace trust/gating plus skills, prompts, root instruction precedence, and `.pi/APPEND_SYSTEM.md` loading.
- [ ] Recommend launching Pi from the project intended as the primary workspace and explain Pi's native cwd resource loading.
- [ ] Document editor wait requirements, non-UI behavior, built-in/local preview assumptions, and the not-a-sandbox limitation.
- [ ] Point users to the generated commented TOML for the complete schema; do not duplicate it in README.
- [ ] Verify pnpm package metadata, published files, and clean installation.
- [ ] Run typechecking, all tests, and final manual Pi checks with supported editors.
- [ ] Optionally install a small tool-capable Gemma 3 model through Ollama for final manual smoke testing.
- [ ] Record future ideas separately from initial Pi-only scope.

**Final review checkpoint:** Approve documentation, package contents, known limitations, and release readiness.
