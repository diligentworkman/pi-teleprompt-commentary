export type ContextSourcePathInspection = "file" | "missing" | "invalid";

export type WorkspaceContextSource = {
  kind: "instructions" | "system-prompt-append";
  workspacePath: string;
  sourcePath: string;
  content: string;
};

export type WorkspaceContextSourceReader = {
  readFile(path: string): Promise<string>;
};

export type WorkspaceContextStatus =
  | {
      workspacePath: string;
      availability: "available";
    }
  | {
      workspacePath: string;
      availability: "unavailable";
      reason: string;
    };

export type WorkspaceContextFormattingInput = {
  primaryWorkspaceStatus: WorkspaceContextStatus;
  additionalWorkspaceSelections: ReadonlyArray<WorkspaceContextSourceSelection>;
  contextSources: ReadonlyArray<WorkspaceContextSource>;
};

export type WorkspaceContextFileSystem = {
  stat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
};

export type WorkspaceContextSourceSelection =
  | {
      workspacePath: string;
      availability: "unavailable";
      reason: string;
    }
  | {
      workspacePath: string;
      availability: "available";
      instructionPath?: string;
      systemPromptAppendPath?: string;
    };
