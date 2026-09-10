export type WorkspaceFileSystem = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};

export type WorkspaceState = {
  primaryWorkspace: string;
  additionalWorkspaces: readonly string[];
};

export type WorkspaceListView = {
  primaryWorkspace: {
    path: string;
    availability: "available" | "unavailable";
  };
  additionalWorkspaces: readonly string[];
};

export type WorkspaceAddOutcome = {
  type: "workspace-added" | "workspace-already-present";
  state: WorkspaceState;
};

export type WorkspaceRemoveOutcome = {
  type:
    | "workspace-removed"
    | "workspace-not-found"
    | "primary-workspace-not-removable";
  state: WorkspaceState;
};

