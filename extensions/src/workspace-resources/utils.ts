import { getErrorMessage, isErrorWithCode } from "#/errors/index.ts";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { workspaceResourceDirectories } from "./constants.ts";
import { warningMessageTemplates } from "./messages.ts";
import type {
  WorkspaceResourceFileSystem,
  WorkspaceResources,
} from "./types.ts";

async function inspectResourceDirectory({
  resourcePath,
  fileSystem,
  reportWarning,
}: {
  resourcePath: string;
  fileSystem: WorkspaceResourceFileSystem;
  reportWarning(message: string): void;
}) {
  try {
    const metadata = await fileSystem.stat(resourcePath);
    if (!metadata.isDirectory()) {
      reportWarning(
        warningMessageTemplates.resourcePathNotDirectory(resourcePath),
      );

      return false;
    }

    return true;
  } catch (error) {
    if (!isErrorWithCode({ error, code: "ENOENT" })) {
      reportWarning(
        warningMessageTemplates.resourcePathInspectionFailed({
          resourcePath,
          reason: getErrorMessage(error),
        }),
      );
    }

    return false;
  }
}

export async function discoverWorkspaceResources({
  additionalWorkspaces,
  fileSystem = { stat },
  reportWarning,
}: {
  additionalWorkspaces: ReadonlyArray<string>;
  fileSystem?: WorkspaceResourceFileSystem;
  reportWarning(message: string): void;
}) {
  const resources: WorkspaceResources = { skillPaths: [], promptPaths: [] };
  for (const workspacePath of additionalWorkspaces) {
    try {
      const metadata = await fileSystem.stat(workspacePath);
      if (!metadata.isDirectory()) {
        reportWarning(
          warningMessageTemplates.additionalWorkspaceUnavailable({
            workspacePath,
            reason: "path is not a directory",
          }),
        );
        continue;
      }
    } catch (error) {
      reportWarning(
        warningMessageTemplates.additionalWorkspaceUnavailable({
          workspacePath,
          reason: isErrorWithCode({ error, code: "ENOENT" })
            ? "path does not exist"
            : getErrorMessage(error),
        }),
      );
      continue;
    }
    for (const relativePath of workspaceResourceDirectories.skills) {
      const resourcePath = join(workspacePath, relativePath);
      if (
        await inspectResourceDirectory({
          resourcePath,
          fileSystem,
          reportWarning,
        })
      ) {
        resources.skillPaths.push(resourcePath);
      }
    }
    for (const relativePath of workspaceResourceDirectories.prompts) {
      const resourcePath = join(workspacePath, relativePath);
      if (
        await inspectResourceDirectory({
          resourcePath,
          fileSystem,
          reportWarning,
        })
      ) {
        resources.promptPaths.push(resourcePath);
      }
    }
  }

  return resources;
}
