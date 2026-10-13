import { attempt } from "#/errors/index.ts";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeTemporaryFileStore,
  RuntimeTemporaryFileStoreDependencies,
} from "./types.ts";

export type {
  RuntimeTemporaryFile,
  RuntimeTemporaryFileStore,
} from "./types.ts";

const defaultDependencies: RuntimeTemporaryFileStoreDependencies = {
  temporaryRootPath: tmpdir(),
  createFileId: randomUUID,
};

export function createRuntimeTemporaryFileStore(
  dependencies: RuntimeTemporaryFileStoreDependencies = defaultDependencies,
): RuntimeTemporaryFileStore {
  let directoryPath: string | undefined;
  const filePaths = new Set<string>();
  let directoryCreation: Promise<string> | undefined;
  const createDirectory = async (): Promise<string> => {
    if (directoryPath !== undefined) {
      return directoryPath;
    }
    const createdDirectoryPath = await mkdtemp(
      join(dependencies.temporaryRootPath, "pi-teleprompt-commentary-"),
    );
    const permissionAttempt = await attempt(() =>
      chmod(createdDirectoryPath, 0o700),
    );
    if (!permissionAttempt.success) {
      await attempt(() =>
        rm(createdDirectoryPath, { recursive: true, force: true }),
      );
      throw permissionAttempt.error;
    }
    directoryPath = createdDirectoryPath;

    return createdDirectoryPath;
  };
  const ensureDirectory = async (): Promise<string> => {
    if (directoryPath !== undefined) return directoryPath;
    directoryCreation ??= createDirectory();
    try {
      return await directoryCreation;
    } finally {
      directoryCreation = undefined;
    }
  };

  return {
    async createFile({ kind, content }) {
      const activeDirectoryPath = await ensureDirectory();
      const filePath = join(
        activeDirectoryPath,
        `${kind}-${dependencies.createFileId()}.txt`,
      );
      const handle = dependencies.openFile === undefined
        ? await open(filePath, "wx", 0o600)
        : await dependencies.openFile(filePath);
      filePaths.add(filePath);
      const writeAttempt = await attempt(() => handle.writeFile(content));
      const closeAttempt = await attempt(() => handle.close());
      // Closing must not hide the original write failure.
      const fileAttempt = writeAttempt.success ? closeAttempt : writeAttempt;
      if (!fileAttempt.success) {
        const removal = await attempt(() => rm(filePath, { force: true }));
        if (removal.success) {
          filePaths.delete(filePath);
        }
        throw fileAttempt.error;
      }
      let cleaned = false;

      return {
        path: filePath,
        async cleanup() {
          if (cleaned) {
            return;
          }
          await rm(filePath, { force: true });
          cleaned = true;
          filePaths.delete(filePath);
        },
      };
    },
    async cleanup() {
      if (directoryPath === undefined) {
        return;
      }
      await rm(directoryPath, { recursive: true, force: true });
      directoryPath = undefined;
      filePaths.clear();
    },
  };
}
