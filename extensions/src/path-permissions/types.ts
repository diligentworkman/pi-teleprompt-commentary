export type WorkspacePathAssessmentInput = {
  requestedPaths: ReadonlyArray<string>;
  workspacePaths: ReadonlyArray<string>;
  cwd: string;
  homeDirectory: string;
};

export type WorkspacePathAssessment =
  | {
      type: "inside";
      canonicalPaths: Array<string>;
    }
  | {
      type: "outside";
      canonicalPaths: Array<string>;
      outsidePaths: Array<string>;
    }
  | {
      type: "resolution-failed";
      path: string;
      error: unknown;
    };

export type WorkspacePathPermissionOutcome =
  | { type: "allowed" }
  | { type: "blocked"; reason: string };

export type WorkspacePathPermissionInput = {
  assessment: WorkspacePathAssessment;
  toolName: string;
  hasUI: boolean;
};

export type WorkspacePathPermissionDependencies = {
  runPermissionRequestHook(toolName: string): Promise<void>;
  confirmOutsideWorkspaceAccess({
    title,
    message,
  }: {
    title: string;
    message: string;
  }): Promise<boolean>;
};

export type WorkspacePathPermissionParameters = {
  input: WorkspacePathPermissionInput;
  dependencies: WorkspacePathPermissionDependencies;
};

export type WorkspacePathClassificationInput = {
  paths: ReadonlyArray<string>;
  workspacePaths: ReadonlyArray<string>;
};
