import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConfigLoader } from "#/config-loader/index.ts";
import type { ProcessRunner } from "#/process/index.ts";
import { realpath, stat } from "node:fs/promises";
import { workspaceEntryType } from "./constants.ts";
import {
  errorMessageTemplates,
  warningMessageTemplates,
  workspaceListMessages,
} from "./messages.ts";
import { workspaceSnapshotSchema } from "./schema.ts";
import type {
  WorkspaceAddOutcome,
  WorkspaceFileSystem,
  WorkspaceListView,
  WorkspaceRemoveOutcome,
  WorkspaceState,
} from "./types.ts";

export function formatWorkspaceList({
  primaryWorkspace,
  additionalWorkspaces,
}: WorkspaceListView) {
  const additionalLines = additionalWorkspaces.map((workspacePath) => {
    return `  ${workspacePath}`;
  });
  if (additionalLines.length === 0) {
    additionalLines.push(`  ${workspaceListMessages.noAdditionalWorkspaces}`);
  }

  return [
    workspaceListMessages.primaryWorkspaceHeading,
    primaryWorkspace.availability === "available"
      ? `  ${primaryWorkspace.path}`
      : `  ${primaryWorkspace.path} (${workspaceListMessages.primaryWorkspaceUnavailableMarker})`,
    "",
    workspaceListMessages.additionalWorkspacesHeading,
    ...additionalLines,
  ].join("\n");
}

export async function openWorkspace({
  workspacePath,
  groupId,
  configLoader,
  processRunner,
  reportWarning,
}: {
  workspacePath: string;
  groupId: string;
  configLoader: ConfigLoader;
  processRunner: ProcessRunner;
  reportWarning(message: string): void;
}) {
  let command;
  try {
    command = await configLoader.resolveHandler({
      category: "workspace_opener",
      variables: { directory_path: workspacePath, group_id: groupId },
    });
  } catch (error) {
    reportWarning(
      errorMessageTemplates.workspaceOpenFailed({
        workspacePath,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );

    return;
  }
  if (command === undefined) {
    reportWarning(
      warningMessageTemplates.workspaceOpenerNotConfigured(workspacePath),
    );

    return;
  }
  let runningProcess;
  try {
    runningProcess = processRunner.start({ command });
  } catch (error) {
    reportWarning(
      errorMessageTemplates.workspaceOpenFailed({
        workspacePath,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );

    return;
  }
  void runningProcess.completion.then((completion) => {
    if (
      completion.type !== "exited" ||
      completion.exitCode !== 0 ||
      completion.signal !== null
    ) {
      reportWarning(
        warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath,
          completion,
        }),
      );
    }
  });
}

export function restoreWorkspaceSnapshot(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== workspaceEntryType) {
      continue;
    }
    const result = workspaceSnapshotSchema.safeParse(entry.data);
    if (result.success) {
      return result.data;
    }
  }

  return { additionalWorkspaces: [] };
}

export async function resolveWorkspaceDirectory({
  workspacePath,
  fileSystem = { realpath, stat },
}: {
  workspacePath: string;
  fileSystem?: WorkspaceFileSystem;
}) {
  const canonicalPath = await fileSystem.realpath(workspacePath);
  const metadata = await fileSystem.stat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new Error(
      errorMessageTemplates.workspacePathNotDirectory(workspacePath),
    );
  }

  return canonicalPath;
}

export function removeWorkspace({
  state,
  workspacePath,
}: {
  state: WorkspaceState;
  workspacePath: string;
}): WorkspaceRemoveOutcome {
  if (workspacePath === state.primaryWorkspace) {
    return { type: "primary-workspace-not-removable", state };
  }
  if (!state.additionalWorkspaces.includes(workspacePath)) {
    return { type: "workspace-not-found", state };
  }

  return {
    type: "workspace-removed",
    state: {
      primaryWorkspace: state.primaryWorkspace,
      additionalWorkspaces: state.additionalWorkspaces.filter((path) => {
        return path !== workspacePath;
      }),
    },
  };
}

export function addWorkspace({
  state,
  workspacePath,
}: {
  state: WorkspaceState;
  workspacePath: string;
}): WorkspaceAddOutcome {
  if (
    workspacePath === state.primaryWorkspace ||
    state.additionalWorkspaces.includes(workspacePath)
  ) {
    return { type: "workspace-already-present", state };
  }

  return {
    type: "workspace-added",
    state: {
      primaryWorkspace: state.primaryWorkspace,
      additionalWorkspaces: [...state.additionalWorkspaces, workspacePath],
    },
  };
}
