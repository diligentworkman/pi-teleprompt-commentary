import { attempt, getErrorMessage } from "#/errors/index.ts";
import {
  blockReasonMessages,
  errorMessageTemplates,
  permissionPromptMessages,
} from "./messages.ts";
import type {
  WorkspacePathPermissionOutcome,
  WorkspacePathPermissionParameters,
} from "./types.ts";

export { assessWorkspacePaths, findOutsideWorkspacePaths } from "./utils.ts";
export type {
  WorkspacePathAssessment,
  WorkspacePathPermissionOutcome,
} from "./types.ts";

export async function requestWorkspacePathPermission({
  input: { assessment, toolName, hasUI },
  dependencies: {
    runPermissionRequestHook,
    confirmOutsideWorkspaceAccess,
  },
}: WorkspacePathPermissionParameters): Promise<WorkspacePathPermissionOutcome> {
  if (assessment.type === "inside") {
    return { type: "allowed" };
  }
  if (assessment.type === "resolution-failed") {
    return {
      type: "blocked",
      reason: errorMessageTemplates.resolutionFailed({
        path: assessment.path,
        errorMessage: getErrorMessage(assessment.error),
      }),
    };
  }
  await attempt(() => runPermissionRequestHook(toolName));
  if (!hasUI) {
    return { type: "blocked", reason: blockReasonMessages.uiUnavailable };
  }
  const allowed = await confirmOutsideWorkspaceAccess({
    title: permissionPromptMessages.title,
    message: permissionPromptMessages.body({
      toolName,
      outsidePaths: assessment.outsidePaths,
    }),
  });
  if (!allowed) {
    return {
      type: "blocked",
      reason: blockReasonMessages.permissionNotGranted,
    };
  }

  return { type: "allowed" };
}
