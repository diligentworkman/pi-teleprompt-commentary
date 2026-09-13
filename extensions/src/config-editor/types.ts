import type {
  ProcessCompletion,
  ProcessRunner,
} from "#/process/index.ts";

export type ConfigEditOutcome =
  | {
      type: "configured-editor-finished";
      completion: ProcessCompletion;
    }
  | { type: "pi-editor-saved" }
  | { type: "pi-editor-cancelled" }
  | { type: "editor-unavailable" };

export type ConfigEditorDependencies = {
  ensureConfigurationFile(): Promise<EnsuredConfigurationFile>;
  resolveConfigurationEditor(): Promise<
    [executable: string, ...args: Array<string>] | undefined
  >;
  processRunner: ProcessRunner;
  reportConfiguredEditorFailure(completion: ProcessCompletion): void;
  readConfigurationFile(): Promise<string>;
  openPiEditor?: (source: string) => Promise<string | undefined>;
  saveConfiguration(source: string): Promise<void>;
  revalidateConfiguration(): Promise<void>;
};

export type ConfigEditor = {
  edit(): Promise<ConfigEditOutcome>;
};

export type ConfigurationFileSystem = {
  createDirectory(directoryPath: string): Promise<void>;
  createFileExclusively({
    filePath,
    source,
  }: {
    filePath: string;
    source: string;
  }): Promise<void>;
  readFile(filePath: string): Promise<string>;
};

export type EnsuredConfigurationFile = {
  source: string;
  created: boolean;
};
