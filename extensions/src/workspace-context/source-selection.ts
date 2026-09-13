import { getErrorMessage, isErrorWithCode } from "#/errors/index.ts";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  rootInstructionFileNames,
  systemPromptAppendRelativePath,
} from "./constants.ts";
import {
  warningMessageTemplates,
  workspaceStatusMessageTemplates,
} from "./messages.ts";
import type {
  ContextSourcePathInspection,
  WorkspaceContextFileSystem,
  WorkspaceContextSourceSelection,
} from "./types.ts";

async function inspectContextSourcePath({
  sourcePath,
  fileSystem,
  reportWarning,
}: {
  sourcePath: string;
  fileSystem: WorkspaceContextFileSystem;
  reportWarning(message: string): void;
}): Promise<ContextSourcePathInspection> {
  try {
    const metadata = await fileSystem.stat(sourcePath);
    if (!metadata.isFile()) {
      reportWarning(
        warningMessageTemplates.contextSourcePathNotFile(sourcePath),
      );

      return "invalid";
    }

    return "file";
  } catch (error) {
    if (isErrorWithCode({ error, code: "ENOENT" })) {
      return "missing";
    }
    reportWarning(
      warningMessageTemplates.contextSourcePathInspectionFailed({
        sourcePath,
        reason: getErrorMessage(error),
      }),
    );

    return "invalid";
  }
}

export async function selectWorkspaceContextSources({
  workspacePath,
  fileSystem = { stat },
  reportWarning,
}: {
  workspacePath: string;
  fileSystem?: WorkspaceContextFileSystem;
  reportWarning(message: string): void;
}): Promise<WorkspaceContextSourceSelection> {
  try {
    const metadata = await fileSystem.stat(workspacePath);
    if (!metadata.isDirectory()) {
      const reason = workspaceStatusMessageTemplates.pathIsNotDirectory();
      reportWarning(
        warningMessageTemplates.additionalWorkspaceUnavailable({
          workspacePath,
          reason,
        }),
      );

      return {
        workspacePath,
        availability: "unavailable",
        reason,
      };
    }
  } catch (error) {
    const reason = isErrorWithCode({ error, code: "ENOENT" })
      ? workspaceStatusMessageTemplates.pathDoesNotExist()
      : getErrorMessage(error);
    reportWarning(
      warningMessageTemplates.additionalWorkspaceUnavailable({
        workspacePath,
        reason,
      }),
    );

    return {
      workspacePath,
      availability: "unavailable",
      reason,
    };
  }
  let instructionPath: string | undefined;
  for (const fileName of rootInstructionFileNames) {
    const sourcePath = join(workspacePath, fileName);
    const inspection = await inspectContextSourcePath({
      sourcePath,
      fileSystem,
      reportWarning,
    });
    if (inspection === "file") {
      instructionPath = sourcePath;
      break;
    }
    if (inspection === "invalid") {
      break;
    }
  }
  const systemPromptAppendPath = join(
    workspacePath,
    systemPromptAppendRelativePath,
  );
  const systemPromptAppendInspection = await inspectContextSourcePath({
    sourcePath: systemPromptAppendPath,
    fileSystem,
    reportWarning,
  });

  return {
    workspacePath,
    availability: "available",
    ...(instructionPath === undefined ? {} : { instructionPath }),
    ...(systemPromptAppendInspection === "file"
      ? { systemPromptAppendPath }
      : {}),
  };
}
