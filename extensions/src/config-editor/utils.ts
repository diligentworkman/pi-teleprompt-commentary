import { attempt, isErrorWithCode } from "#/errors/index.ts";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { starterConfigurationReferenceUrl } from "./constants.ts";
import type {
  ConfigurationFileSystem,
  EnsuredConfigurationFile,
} from "./types.ts";

export const configurationFileSystem: ConfigurationFileSystem = {
  async createDirectory(directoryPath) {
    await mkdir(directoryPath, { recursive: true });
  },
  async createFileExclusively({ filePath, source }) {
    await writeFile(filePath, source, { encoding: "utf8", flag: "wx" });
  },
  readFile(filePath) {
    return readFile(filePath, "utf8");
  },
};

export function isConfigurationFileAlreadyExistsError(error: unknown) {
  return isErrorWithCode({ error, code: "EEXIST" });
}

export async function ensureConfigurationFile({
  configFilePath,
  starterSource,
  fileSystem,
}: {
  configFilePath: string;
  starterSource: string;
  fileSystem: ConfigurationFileSystem;
}): Promise<EnsuredConfigurationFile> {
  await fileSystem.createDirectory(dirname(configFilePath));
  try {
    await fileSystem.createFileExclusively({
      filePath: configFilePath,
      source: starterSource,
    });

    return { source: starterSource, created: true };
  } catch (error) {
    if (!isConfigurationFileAlreadyExistsError(error)) {
      throw error;
    }
  }

  return {
    source: await fileSystem.readFile(configFilePath),
    created: false,
  };
}

export async function writeConfigurationFileAtomically({
  configFilePath,
  source,
  createFileId = randomUUID,
}: {
  configFilePath: string;
  source: string;
  createFileId?(): string;
}): Promise<void> {
  const temporaryFilePath = `${configFilePath}.${createFileId()}.tmp`;
  // Failed exclusive opening grants no ownership and must not trigger removal.
  const handle = await open(temporaryFilePath, "wx");
  const writeAttempt = await attempt(() => handle.writeFile(source, "utf8"));
  const closeAttempt = await attempt(() => handle.close());
  const preparation = writeAttempt.success ? closeAttempt : writeAttempt;
  const replacement = preparation.success
    ? await attempt(() => rename(temporaryFilePath, configFilePath))
    : preparation;
  if (!replacement.success) {
    await attempt(() => rm(temporaryFilePath, { force: true }));
    throw replacement.error;
  }
}

export function createStarterConfigurationSource(
  referenceSource: string,
): string {
  return referenceSource
    .split("\n")
    .map((line) => {
      if (line === "") {
        return line;
      }
      if (line.startsWith("#")) {
        return `#${line}`;
      }

      return `# ${line}`;
    })
    .join("\n");
}

export function readStarterConfigurationReference(): Promise<string> {
  return readFile(starterConfigurationReferenceUrl, "utf8");
}

export async function readStarterConfigurationSource(): Promise<string> {
  return createStarterConfigurationSource(
    await readStarterConfigurationReference(),
  );
}
