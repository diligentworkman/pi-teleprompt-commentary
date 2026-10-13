# Stage 13 — Regression and Recovery Evidence

Stage 13 is approved with the verification limitations and manual deferrals below. `implementation_plan.md` is authoritative. This approval permits Stage 14 documentation work; it is not release approval.

## Evidence recorded so far

- Stages 1–12 were approved after their feature verification and manual checkpoints.
- The user confirmed focused tests and typechecking for the approved Stage 13 fixes: workspace literal identity and native-read fallback compatibility; late hook/editor/opener launch prevention; temporary/config-save ownership and error precedence; FIFO snapshot rejection; shared handle-closure error handling; public feature indexes; stale workspace mutations; opener completion/reporting isolation; configuration-warning fallback; existing-target symlink preservation; new-target parent validation; and Bash acceptance with unconfirmed editor termination.
- Subsequent read-only review found no new defects in deferred-action consumption, result patching, reservation release, or the reviewed shutdown ordering. Installed Pi source was inspected to confirm `tool_result` precedes `tool_execution_end`; this ordering remains a compatibility assumption, not a cross-version guarantee.
- Whitespace checks passed after the approved edits. The assistant did not run tests during this audit.
- The user confirmed that full automated verification passed. Exact suite totals, point versions, and repeated clean-checkout provenance were not supplied; do not infer them from that confirmation.
- The user manually verified default write rejection/acceptance and feedback, default edit acceptance without feedback, outside-workspace permission denial/approval, workspace add/remove and permission changes, session resume, branch-sensitive restoration, clean configured configuration-editor exit, and unchanged external file review. Testing used the normal Pi profile and disposable workspace fixtures.
- The user approved deferring the remaining manual checks to daily use after discussing temporary real-file mutation, abrupt termination, file replacement, detached-editor saves, and failed reviewed-content application. Deferred checks are not passed checks.

## Coverage inventory

The following paths identify existing regression coverage, not a new test-run result.

- **Configuration and editing:** `extensions/tests/unit/config-loader/*.spec.ts`, `extensions/tests/unit/config-editor/*.spec.ts`, and `extensions/tests/wiring/config-editor.spec.ts` cover parsing, matching, expansion, current-warning fallback, editor failures, atomic-save ownership, and shutdown boundaries.
- **Workspace persistence and commands:** `extensions/tests/unit/workspaces/*.spec.ts` and `extensions/tests/wiring/workspace-*.spec.ts` cover snapshots, canonical identity, add/remove/list/open, resource/context selection, stale mutations, and late opener launches. `extensions/tests/wiring/workspaces-open.spec.ts` covers group ordering and completion failure isolation.
- **Path permission and ownership:** `extensions/tests/unit/paths/*.spec.ts`, `extensions/tests/unit/path-permissions/*.spec.ts`, `extensions/tests/unit/path-reservations/*.spec.ts`, and their wiring specs cover native-read selection, containment, permission outcomes, and reservation lifecycle.
- **Prompts and races:** `extensions/tests/unit/review-prompts/*.spec.ts`, `extensions/tests/unit/review-policies/*.spec.ts`, `extensions/tests/unit/review-coordinator/*.spec.ts`, and `extensions/tests/wiring/basic-review.spec.ts` cover decisions, feedback, race ordering, cancellation, and unconfirmed cleanup.
- **File restoration and deferred application:** `extensions/tests/unit/file-preview/*.spec.ts`, `extensions/tests/unit/file-review/*.spec.ts`, and `extensions/tests/wiring/file-review.spec.ts` cover real native previews, exact snapshots, freshness, detected replacements, new-parent cleanup, reviewed-content application, original-tool errors, repeated results, and shutdown restoration.
- **Bash review:** `extensions/tests/unit/bash-review/*.spec.ts` and `extensions/tests/wiring/bash-review.spec.ts` cover command editing, empty edits, prompt feedback, termination outcomes, transcript annotations, and shutdown.
- **Shared cleanup and hooks:** `extensions/tests/unit/errors/*.spec.ts`, `extensions/tests/unit/process/*.spec.ts`, `extensions/tests/unit/runtime-temporary-files/*.spec.ts`, `extensions/tests/unit/post-tool-actions/*.spec.ts`, `extensions/tests/unit/event-hooks/*.spec.ts`, and `extensions/tests/wiring/event-hooks.spec.ts` cover error precedence, process/artifact ownership, once-only action consumption, and isolated hook dispatch.
- **Extension admission:** `extensions/tests/wiring/extension-registration.spec.ts` covers registration and namespaced commands.

## Full verification — passed; detailed provenance and clean-checkout repetition unrecorded

- Ensure all approved changes, including new specs and documentation, are included in the revision being verified. A checkout of the old HEAD does not include uncommitted or untracked work; do not discard current work to obtain cleanliness.
- Use a separate clean checkout of that revision. If created as a verification fixture, keep it beneath a dedicated OS temporary root.
- Record the revision, platform, Node, pnpm, and Pi versions. Compare them with the supported baseline in `README.md`; disclose any mismatch rather than treating it as baseline verification.
- Install using the project's established pnpm workflow. Then run `pnpm run typecheck`, `pnpm test`, and `pnpm run verify`.
- Repeat the complete verification from the same clean source state. Record commands, pass/fail results, suite totals, skips, and any unexpected filesystem changes or surviving processes.
- Record Windows path/symlink coverage as unverified unless actually exercised on Windows. Platform skips and editor availability must remain explicit.

## Manual Pi recovery checklist — partially completed; remainder deferred

### Isolated setup

- Run `bash manual-test.sh`. The opened shell supplies `PI_TELEPROMPT_TEST_ROOT`, a primary workspace, and `pi-tc`; exiting that shell deletes its temporary root.
- Before launching Pi, run `export PI_CODING_AGENT_DIR="$PI_TELEPROMPT_TEST_ROOT/pi-agent"` and `export TMPDIR="$PI_TELEPROMPT_TEST_ROOT/tmp"`, then `mkdir -p -- "$PI_CODING_AGENT_DIR" "$TMPDIR"`. This isolates configuration, session artifacts, and runtime temporary files beneath the fixture root. Configure authentication/model access for this isolated profile as necessary; do not paste credentials into the evidence record.
- Put additional workspaces, outside-workspace fixtures, symlink targets, editor fixtures, and failure-recovery copies beneath the same temporary root. Never point a test symlink outside it.
- Start `pi-tc`. Use Ctrl-Z and `fg` when shell inspection/setup is needed. Preserve logs and observations before exiting the temporary shell.

### Configuration, workspaces, and permissions

- Check `tc:*` command discovery. Create the starter through `/tc:edit-config`; verify clean editor exit, Pi-editor cancellation, and an intentionally missing editor executable with interactive fallback.
- Introduce malformed TOML, then an invalid regex. Confirm current warnings recur on affected actions, safe defaults remain usable, and fixing the isolated configuration takes effect without reload.
- Add and remove additional workspaces; confirm resource reload and primary/additional listing. Resume and navigate session branches to verify the nearest active-branch snapshot, including an empty list.
- Exercise inside/outside access, denial, cancellation, and an outside-target symlink. Check supported path tools and omitted-path directory tools. Keep all targets inside the temporary root.
- Open one workspace and the full group; check path arguments and shared group behavior. Use a missing opener and confirm later group members still launch. Shutdown must not start another opener.
- Treat adversarial concurrent branch/mutation ordering as fake-API regression evidence; do not claim ordinary Pi UI exposes that ordering unless observed.

### Review decisions and filesystem recovery

- With defaults, accept and reject file changes with optional feedback. Confirm acceptance feedback appears once and rejection feedback appears in the block reason; default Bash remains unchanged.
- With a supported waiting editor, test existing `write` and `edit`, a nested new file, unchanged content, changed content, and intentionally empty content. Confirm restoration before normal execution and reviewed content afterward, with concise annotations.
- Test prompt-first acceptance/rejection and editor-first completion. Confirm loser cancellation, no stale prompt, and restoration. Test a missing/nonzero editor with UI and non-UI behavior where practical.
- While reviewing a new nested file, add unrelated content to a preview-created parent. Confirm that content survives and incomplete cleanup is reported rather than claimed successful.
- Exercise detected target/parent replacement only within the temporary fixture. Confirm replacement content is preserved and normal execution is blocked when restoration is incomplete. Same-inode symlink regressions are also covered by focused automated tests.
- Review a Bash command, save a nonempty replacement, and verify the exact edited command executes and is annotated. Save an empty command and verify it blocks. Use harmless fixture-only commands, never destructive commands against real data.
- Exit/reload during an active review using supported Pi interaction. Inspect original files, new preview paths, and the extension's runtime artifacts. Distinguish orderly shutdown recovery from abrupt process death; reload races and detached GUI editors are best-effort limitations.
- Confirm retry is possible after rejection/result cleanup, and same-path overlap is blocked while ownership is retained when that ordering can be exercised. Use automated wiring evidence for concurrency not available through ordinary UI.

### Hooks and final cleanup

- Configure harmless observable hook commands in the isolated TOML. Verify additive order, failure isolation, assistant-text/tool-summary context, settled events, and permission hooks only for live interactive permission requests.
- Inspect launched waiting-editor children and `pi-teleprompt-commentary-*` runtime directories attributable to this run. Verify orderly shutdown removes owned artifacts; do not delete unrelated temporary directories or processes.
- Close remaining GUI tabs without saving stale proposal buffers. A terminated CLI launcher does not guarantee a detached GUI tab has closed.
- Record the editor and waiting flags used, manual outcomes, recoveries needed, and unavailable/skipped checks. Exit the temporary shell only after collecting evidence.

## Approved checkpoint record

- Full automated verification: user-confirmed passed.
- Revision and exact runtime/platform versions: unrecorded. The user described Node 24+, pnpm 11+, and Pi 1+; these are not precise verified versions or an approved open-ended compatibility range.
- Repeated clean-checkout provenance: unrecorded; retained as outstanding release evidence, not marked complete.
- Manual checks: the completed subset is recorded above. Other editor/platform coverage is unverified.
- Deferred manual checks: configuration failure/fallback recovery; changed/empty external file contents; prompt/editor race and cancellation flows; shutdown/reload recovery and leak inspection; workspace opening/group opening; edited/empty Bash commands; hooks; and practical non-UI checks. Automated coverage remains available for these behaviors.
- Remaining limitations: filesystem TOCTOU, detached editors, mid-call reload/abrupt termination, runtime-local ownership only, local native text-tool assumptions, and unverified Windows behavior. Original-content artifacts are not durable backups; important uncommitted work needs independent backup.
- Stage 13 approval: user-approved with those explicit deferrals. Stage 14 may proceed; final release readiness remains a separate approval.
