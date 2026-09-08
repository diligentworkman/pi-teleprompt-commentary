# Pi Teleprompt Commentary

Pi Teleprompt Commentary is a Pi-only extension for reviewing agent tool calls and managing explicit session workspaces.

## Compatibility baseline

This package supports:

- Pi `>=0.84.1 <0.85.0`;
- Node.js `>=22.19.0 <25`;
- pnpm 11.x for dependency management.

The baseline relies only on Pi's public extension API: namespaced extension commands, lifecycle events, `tool_call`/`tool_result` interception, resource discovery, branch-aware session access, and the public local `write`/`edit` definitions. These assumptions must be rechecked for every Pi minor-version upgrade.

## Development

```sh
pnpm run typecheck
pnpm test
pnpm run verify
```

Interactive Pi checks are deliberately manual. See `task.md` for the review checkpoints.
