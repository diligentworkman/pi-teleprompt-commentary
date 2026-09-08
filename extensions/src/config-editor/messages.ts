import type { ProcessCompletion } from "#/process/index.ts";

export const messages = {
  usage: "Usage: /tc:edit-config",
  saved: "Configuration saved.",
  cancelled: "Configuration edit cancelled.",
  configuredEditorFinished: "Configuration editor finished.",
  editorUnavailable: "No configuration editor is available.",
} as const;

export const errorMessageTemplates = {
  configuredEditorDidNotExitCleanly(completion: ProcessCompletion): string {
    if (completion.type === "spawn-failed") {
      return `Configuration editor could not start: ${completion.error.message}`;
    }
    if (completion.signal !== null) {
      return `Configuration editor exited after signal ${completion.signal}.`;
    }

    return `Configuration editor exited with code ${String(completion.exitCode)}.`;
  },
} as const;
