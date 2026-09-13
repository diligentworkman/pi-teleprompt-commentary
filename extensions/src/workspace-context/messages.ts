export const workspaceStatusMessageTemplates = {
  pathDoesNotExist() {
    return "path does not exist";
  },
  pathIsNotDirectory() {
    return "path is not a directory";
  },
};

export const warningMessageTemplates = {
  contextSourceReadFailed({
    sourcePath,
    reason,
  }: {
    sourcePath: string;
    reason: string;
  }) {
    return `Cannot read workspace context source "${sourcePath}": ${reason}`;
  },
  additionalWorkspaceUnavailable({
    workspacePath,
    reason,
  }: {
    workspacePath: string;
    reason: string;
  }) {
    return `Additional workspace "${workspacePath}" is unavailable: ${reason}`;
  },
  contextSourcePathInspectionFailed({
    sourcePath,
    reason,
  }: {
    sourcePath: string;
    reason: string;
  }) {
    return `Cannot inspect workspace context source path "${sourcePath}": ${reason}`;
  },
  contextSourcePathNotFile(sourcePath: string) {
    return `Workspace context source path "${sourcePath}" is not a file.`;
  },
};
