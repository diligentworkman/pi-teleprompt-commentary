# Working Agreement

## Scope and review

- Complete one `task.md` section at a time and stop at every review checkpoint.
- Record completed work by ticking only the applicable `task.md` checkboxes.
- Record approved product/architecture deviations in `plan_modifications.md` and update the related task item in the same change.
- The user performs manual Pi testing and runs verification commands. Do not run tests unless explicitly asked.
- Perform every manual or ad hoc filesystem test entirely within a dedicated directory under the operating system temporary directory. All test workspaces, paths, files, and symlinks—including the primary workspace—must remain below that temporary root. Never create, modify, link, or delete test artifacts in the repository or any other non-temporary directory.

## Files and package management

- Read every file targeted for a change immediately before editing it.
- Use targeted edit/write tool calls for source changes. Do not use ad hoc scripts to edit files unless the user explicitly approves the script and its exact scope first.
- Do not read, edit, or otherwise touch `package.json`, `pnpm-lock.yaml`, or pnpm workspace files.
- Keep feature code within its `index.ts`, `schema.ts`, `types.ts`, and `utils.ts` files unless a separate module is clearly justified.
- Use `describe`/`it` style for tests.

## Incremental implementation

- Start by agreeing on the root-facing contract and stub every immediate dependency.
- Do not test an unfinished root or a function that depends on a stub.
- Prefer testing declarative schemas through their completed consuming behavior (such as parsing or restoration), rather than creating standalone schema specs. Verify project-specific validation contracts, not validation-library mechanics; avoid duplicating that coverage across layers.
- Work from the dependency leaves upward: implement one dependency-free function, review it, add its focused spec, and have the user run it before moving upward.
- Prioritize correctness, clarity, and reviewability over implementation speed. Do not move faster than the current change can be understood and reviewed.
- Avoid adding multiple functions at once unless they are necessary stubs for one parent contract.
- Apply design effort proportionally to the task, intended lifetime, responsibility, and risk. Keep durable production code and behavioral specs clean and maintainable; keep temporary scaffolding minimal, and do not build abstractions for hypothetical future needs.
- Add brief comments that explain why non-obvious decisions or constraints exist. Do not narrate what obvious code does; use what-oriented comments only when they are necessary for understanding.

## Style

- Prefer clear, descriptive names without making them unnecessarily long.
- Use explicit function return types when they communicate domain outcomes, enforce invariants, or define dependency/API contracts independently of the implementation. Prefer inference for straightforward transformations, delegating wrappers, and small helpers with obvious results. Prefer an explicit contract over repeated casts or literal-preservation machinery. Decide by contract clarity, not merely public/private visibility or function complexity.
- Use `Array<T>` for homogeneous array types and `ReadonlyArray<T>` for their readonly counterparts. Reserve bracket syntax for tuple types.
- Use a direct parameter when a project-defined function accepts exactly one argument. Use a named parameter object when it accepts multiple arguments; framework callbacks and third-party APIs retain their required signatures.
- Use block statements for `if`/control-flow bodies and functions. Avoid terse one-line arrow functions except when the user explicitly prefers one.
- Preserve the user's established formatting. Ask before resolving ambiguous formatting choices.
- Treat specs as executable documentation: they must read clearly from top to bottom, use deliberate behavioral grouping and names, hide incidental setup behind readable helpers, and avoid brittle or implementation-heavy assertions.
- Name shared conceptual test values once at their nearest common scope. Avoid repeated literals, setup, and expected values within one spec when they represent the same concept; duplication across specs or features is acceptable when their test dynamics differ.
- Keep test machinery local to its spec file, generally as module-level helpers outside `describe`/`it`. Helpers may arrange inputs, dependencies, fakes, and captured outputs, but must not contain assertions; every assertion remains visible in its `it` block. Do not build shared cross-spec fixture, harness, or fake frameworks; tests may repeat boundary setup to remain independent and purpose-specific.
- Across feature boundaries, use the `#/` alias and import public APIs only from the feature's `index.ts`. Same-feature code may use relative imports. Behavioral tests use public feature indexes; focused internal utility specs may deep-import the internal module they explicitly exercise.
