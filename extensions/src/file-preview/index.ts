import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { attempt, attemptWithCleanup } from "#/errors/index.ts";
import { classifyFileReviewTarget } from "#/file-review-targets/index.ts";
import { lstat, open } from "node:fs/promises";
import type {
  ExistingFilePreviewSnapshot,
  ExistingFileRestorationOutcome,
  FilePreviewSnapshotOutcome,
  RunPiFilePreviewParameters,
} from "./types.ts";

export { runRestoredPiFilePreview } from "./restored-preview.ts";

export type { FilePreviewSnapshot, PiFilePreviewInput } from "./types.ts";

export async function captureFilePreviewSnapshot(
  canonicalPath: string,
): Promise<FilePreviewSnapshotOutcome> {
  const classification = await classifyFileReviewTarget(canonicalPath);
  if (!classification.success) {
    return attempt.error(classification.error);
  }
  if (classification.value.type === "new") {
    const target = classification.value;
    return attempt(async () => {
      const ancestor = await lstat(target.nearestExistingAncestorPath);
      if (!ancestor.isDirectory()) {
        throw new Error(`The preview ancestor is not a directory: ${target.nearestExistingAncestorPath}`);
      }
      return {
        ...target,
        ancestorIdentity: { device: ancestor.dev, inode: ancestor.ino },
      };
    });
  }

  const snapshotAttempt = await attempt(async () => {
    // Opening a FIFO can wait indefinitely before handle metadata is available.
    const targetMetadata = await lstat(canonicalPath);
    if (!targetMetadata.isFile()) {
      throw new Error(`The preview target is not a regular file: ${canonicalPath}`);
    }
    const handle = await open(canonicalPath, "r");
    const capture = await attemptWithCleanup({
      async operation() {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          throw new Error(`The preview target is not a regular file: ${canonicalPath}`);
        }
        const originalContent = await handle.readFile();

        return {
          type: "existing" as const,
          canonicalPath,
          originalContent,
          device: metadata.dev,
          inode: metadata.ino,
          mode: metadata.mode & 0o7777,
          accessTime: metadata.atime,
          modificationTime: metadata.mtime,
        };
      },
      cleanup() {
        return handle.close();
      },
    });
    if (!capture.success) {
      throw capture.error;
    }

    return capture.value;
  });
  return snapshotAttempt;
}

export async function restoreExistingFilePreview(
  snapshot: ExistingFilePreviewSnapshot,
): Promise<ExistingFileRestorationOutcome> {
  const restoration = await attempt(async (): Promise<ExistingFileRestorationOutcome> => {
    // A symlink to the moved original still passes a handle-only identity check.
    const targetMetadata = await lstat(snapshot.canonicalPath);
    if (
      !targetMetadata.isFile() ||
      targetMetadata.dev !== snapshot.device ||
      targetMetadata.ino !== snapshot.inode
    ) {
      return { type: "identity-changed" };
    }
    const handle = await open(snapshot.canonicalPath, "r+");
    const restored = await attemptWithCleanup({
      async operation(): Promise<ExistingFileRestorationOutcome> {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.dev !== snapshot.device ||
          metadata.ino !== snapshot.inode
        ) {
          return { type: "identity-changed" };
        }
        await handle.truncate(0);
        await handle.writeFile(snapshot.originalContent);
        await handle.chmod(snapshot.mode);
        await handle.utimes(snapshot.accessTime, snapshot.modificationTime);

        return { type: "restored" };
      },
      cleanup() {
        return handle.close();
      },
    });
    if (!restored.success) {
      throw restored.error;
    }

    return restored.value;
  });
  return restoration.success
    ? restoration.value
    : { type: "failed", error: restoration.error };
}

export async function runPiFilePreview({
  preview,
  toolCallId,
  ctx,
  signal,
}: RunPiFilePreviewParameters): Promise<void> {
  // Pi's built-in write/edit definitions use ctx.cwd; tool_call supplies an
  // ExtensionContext rather than an ExtensionToolContext. These particular
  // local built-ins do not access executeTool() or tools.
  const toolContext = ctx as ExtensionToolContext;
  if (preview.toolName === "write") {
    await createWriteToolDefinition(ctx.cwd).execute(
      toolCallId,
      preview.input,
      signal,
      undefined,
      toolContext,
    );
    return;
  }

  await createEditToolDefinition(ctx.cwd).execute(
    toolCallId,
    preview.input,
    signal,
    undefined,
    toolContext,
  );
}
