import { attempt } from "#/errors/index.ts";
import type { ResolvedCommand } from "#/config-loader/index.ts";
import type { ProcessRunner } from "#/process/index.ts";

/** Dispatch in declaration order without waiting for commands to finish. */
export async function dispatchHookCommands({
  resolveCommands,
  processRunner,
  shouldDispatch,
}: {
  resolveCommands(): Promise<Array<ResolvedCommand>>;
  processRunner: ProcessRunner;
  shouldDispatch?(): boolean;
}): Promise<void> {
  if (shouldDispatch?.() === false) {
    return;
  }
  const commands = await attempt(resolveCommands);
  if (!commands.success) {
    return;
  }
  for (const command of commands.value) {
    // Resolution can outlive shutdown or the prompt this hook announces.
    if (shouldDispatch?.() === false) {
      return;
    }
    const started = attempt.sync(() => processRunner.start({ command }));
    if (started.success) {
      // Observe rejections even for fire-and-forget commands.
      void attempt(() => started.value.completion);
    }
  }
}
