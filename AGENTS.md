# Working Agreement

## Scope and permissions

- Agree on a bounded change, verification, and review checkpoint; stop there. Keep codebase-wide audits read-only until fixes are approved.
- Report changes and verification accurately; distinguish passed, deferred, and unverified checks. Update user docs when behavior or limitations change.
- The user runs manual Pi checks and verification. Run tests only when explicitly asked.
- Keep manual/ad hoc filesystem tests entirely under a dedicated OS-temporary root, including all workspaces, files, and symlinks. Do not create, modify, link, or delete test artifacts elsewhere.
- Do not touch `package.json`, `pnpm-lock.yaml`, or pnpm workspace files unless asked to.

## Editing and structure

- Read each target immediately before editing. Use targeted file tools; editing scripts require approval of the script and its exact scope.
- Keep code within its feature. Use conventional files (`index.ts`, `schema.ts`, `types.ts`, `utils.ts`, `messages.ts`, `constants.ts`) as needed; preserve focused modules. Add files for clear responsibilities, not a fixed layout.
- Cross-feature imports use `#/` and the feature's `index.ts`; same-feature imports may be relative. Export only for implemented cross-feature consumers, not anticipated use or testing alone.

## Implementation

- Agree on the root contract first; implement and verify dependencies leaf-first. Use stubs only for contract review; never test unfinished roots or stub-dependent functions.
- Work one function at a time: implement, review, add a focused spec, and have the user verify before moving upward. Multiple functions are allowed only for necessary parent-contract stubs.
- Prioritize correctness, clarity, and reviewability over speed. Scale design to lifetime and risk; keep temporary scaffolding minimal and avoid speculative abstractions.
- Comment non-obvious reasons and constraints. Explain what only when necessary; do not narrate obvious code.

## Style

- Use clear, descriptive names without needless length.
- Use explicit return types for domain outcomes, invariants, and API contracts; infer obvious transformations, wrappers, and helpers. Prefer clear contracts over casts or literal-preservation tricks, regardless of visibility or complexity.
- Use `Array<T>` and `ReadonlyArray<T>`; reserve bracket syntax for tuples.
- Use a direct parameter for one argument and a named object for multiple arguments. Preserve framework and third-party signatures.
- Use blocks for control flow and functions. Avoid terse one-line arrows unless the user prefers them.
- Preserve established formatting; ask about ambiguity. No blank lines inside functions except before returns. Separate top-level declarations; keep imports together with a blank line before declarations.

## Tests

- Use `describe`/`it`: one feature-level `describe`, nested behavioral groups, and complete behavior-focused names. Specs should read as executable documentation, not implementation checklists.
- Test schemas through completed consumers where practical. Verify project contracts, not library mechanics; avoid duplicate coverage across layers.
- Keep setup helpers local to each spec, normally outside `describe`/`it`. Helpers may arrange fixtures and fakes but contain no assertions; keep every assertion visible in its `it` block. Do not build shared cross-spec test frameworks.
- Name shared conceptual values at their nearest common scope; avoid repeated setup and expectations for the same concept. Duplication between independent specs is acceptable.
- Behavioral tests use public feature indexes; focused utility specs may import the internal module they exercise.
