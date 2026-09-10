import type { ProcessCompletion } from "#/process/index.ts";

export const workspaceListMessages = {
  primaryWorkspaceHeading: "Primary workspace:",
  additionalWorkspacesHeading: "Additional workspaces:",
  noAdditionalWorkspaces: "None",
  primaryWorkspaceUnavailableMarker: "unavailable",
} as const;

export const confirmationMessageTemplates = {
  addWorkspace(workspacePath: string) {
    return `Add "${workspacePath}" to this session?\n\nPi will reload after addition.`;
  },
  removeWorkspace(workspacePath: string) {
    return `Remove "${workspacePath}" from this session?\n\nPi will reload after removal.`;
  },
};

export const infoMessageTemplates = {
  workspaceAlreadyPresent(workspacePath: string) {
    return `Workspace is already part of this session: ${workspacePath}`;
  },
};

export const warningMessageTemplates = {
  workspacesOpenDoesNotAcceptArguments() {
    return "/tc:workspaces-open does not accept arguments.";
  },
  noWorkspacesAvailableToOpen() {
    return "There are no available workspaces to open.";
  },
  workspaceOpenerNotConfigured(workspacePath: string) {
    return `No workspace opener is configured for: ${workspacePath}`;
  },
  workspaceOpenerDidNotExitCleanly({
    workspacePath,
    completion,
  }: {
    workspacePath: string;
    completion: ProcessCompletion;
  }) {
    if (completion.type === "spawn-failed") {
      return `Workspace opener could not start for "${workspacePath}": ${completion.error.message}`;
    }
    if (completion.signal !== null) {
      return `Workspace opener for "${workspacePath}" exited after signal ${completion.signal}.`;
    }

    return `Workspace opener for "${workspacePath}" exited with code ${String(completion.exitCode)}.`;
  },
  primaryWorkspaceUnavailable({
    workspacePath,
    errorMessage,
  }: {
    workspacePath: string;
    errorMessage: string;
  }) {
    return `Primary workspace "${workspacePath}" is unavailable: ${errorMessage}`;
  },
  noAdditionalWorkspacesToRemove() {
    return "There are no additional workspaces to remove.";
  },
  primaryWorkspaceNotRemovable(workspacePath: string) {
    return `The primary workspace cannot be removed: ${workspacePath}`;
  },
  workspaceNotFound(workspacePath: string) {
    return `Workspace is not part of this session: ${workspacePath}`;
  },
};

export const errorMessageTemplates = {
  workspaceOpenFailed({
    workspacePath,
    errorMessage,
  }: {
    workspacePath: string;
    errorMessage: string;
  }) {
    return `Failed to open workspace "${workspacePath}": ${errorMessage}`;
  },
  workspaceAddFailed(errorMessage: string) {
    return `Failed to add workspace: ${errorMessage}`;
  },
  workspaceRemoveFailed(errorMessage: string) {
    return `Failed to remove workspace: ${errorMessage}`;
  },
  workspacePathsMustBeAbsolute() {
    return "Workspace paths must be absolute.";
  },
  workspacePathsMustBeUnique() {
    return "Workspace paths must not contain exact duplicates.";
  },
  workspacePathNotDirectory(workspacePath: string) {
    return `Workspace path "${workspacePath}" is not a directory.`;
  },
};
