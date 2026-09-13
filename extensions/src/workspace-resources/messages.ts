export const warningMessageTemplates = {
  additionalWorkspaceUnavailable({
    workspacePath,
    reason,
  }: {
    workspacePath: string;
    reason: string;
  }) {
    return `Additional workspace "${workspacePath}" is unavailable: ${reason}`;
  },
  resourcePathInspectionFailed({
    resourcePath,
    reason,
  }: {
    resourcePath: string;
    reason: string;
  }) {
    return `Cannot inspect workspace resource path "${resourcePath}": ${reason}`;
  },
  resourcePathNotDirectory(resourcePath: string) {
    return `Workspace resource path "${resourcePath}" is not a directory.`;
  },
};
