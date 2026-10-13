export type RuntimeTemporaryFileKind = "command" | "original-content";

export type RuntimeTemporaryFile = {
  path: string;
  cleanup(): Promise<void>;
};

export type RuntimeTemporaryFileStore = {
  createFile({
    kind,
    content,
  }: {
    kind: RuntimeTemporaryFileKind;
    content: string | Uint8Array;
  }): Promise<RuntimeTemporaryFile>;
  cleanup(): Promise<void>;
};

export type RuntimeTemporaryFileStoreDependencies = {
  temporaryRootPath: string;
  createFileId(): string;
  // Returns a handle for a newly, exclusively created private file.
  openFile?(filePath: string): Promise<{
    writeFile(content: string | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
};
