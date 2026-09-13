export type WorkspaceResourceFileSystem = {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};

export type WorkspaceResources = {
  skillPaths: Array<string>;
  promptPaths: Array<string>;
};
