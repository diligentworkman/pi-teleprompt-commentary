import { getErrorMessage } from "#/errors/index.ts";
import { readFile } from "node:fs/promises";
import { warningMessageTemplates } from "./messages.ts";
import type {
  WorkspaceContextSource,
  WorkspaceContextSourceReader,
  WorkspaceContextSourceSelection,
} from "./types.ts";

export async function readWorkspaceContextSources({
  sourceSelection,
  fileSystem = {
    readFile(path: string) {
      return readFile(path, "utf8");
    },
  },
  reportWarning,
}: {
  sourceSelection: WorkspaceContextSourceSelection;
  fileSystem?: WorkspaceContextSourceReader;
  reportWarning(message: string): void;
}): Promise<Array<WorkspaceContextSource>> {
  const contextSources: Array<WorkspaceContextSource> = [];
  if (sourceSelection.availability === "unavailable") {
    return contextSources;
  }
  const selectedSources: Array<{
    kind: WorkspaceContextSource["kind"];
    sourcePath: string | undefined;
  }> = [
    {
      kind: "instructions",
      sourcePath: sourceSelection.instructionPath,
    },
    {
      kind: "system-prompt-append",
      sourcePath: sourceSelection.systemPromptAppendPath,
    },
  ];
  for (const { kind, sourcePath } of selectedSources) {
    if (sourcePath === undefined) {
      continue;
    }
    try {
      const content = await fileSystem.readFile(sourcePath);
      contextSources.push({
        kind,
        workspacePath: sourceSelection.workspacePath,
        sourcePath,
        content,
      });
    } catch (error) {
      reportWarning(
        warningMessageTemplates.contextSourceReadFailed({
          sourcePath,
          reason: getErrorMessage(error),
        }),
      );
    }
  }

  return contextSources;
}
