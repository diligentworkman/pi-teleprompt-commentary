export const permissionPromptMessages = {
  title: "Allow access outside workspaces?",
  body({
    toolName,
    outsidePaths,
  }: {
    toolName: string;
    outsidePaths: ReadonlyArray<string>;
  }) {
    const pathList = outsidePaths.map((path) => `- ${path}`).join("\n");

    return `The ${toolName} tool wants to access paths outside the configured workspaces:\n\n${pathList}\n\nAllow this tool call?`;
  },
};

export const errorMessageTemplates = {
  resolutionFailed({
    path,
    errorMessage,
  }: {
    path: string;
    errorMessage: string;
  }) {
    return `Could not verify workspace access for "${path}": ${errorMessage}`;
  },
};

export const blockReasonMessages = {
  uiUnavailable:
    "Blocked access outside the configured workspaces because interactive permission is unavailable.",
  permissionNotGranted:
    "Access outside the configured workspaces was not allowed.",
} as const;
