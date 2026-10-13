import { attempt, isErrorWithCode } from "#/errors/index.ts";
import { lstat, rmdir, unlink } from "node:fs/promises";
import type { AttemptResult } from "#/errors/index.ts";
import type {
  FileIdentity,
  NewFilePreviewSnapshot,
  NewFilePreviewState,
  NewFileRestorationOutcome,
} from "./types.ts";

function isSameIdentity(
  metadata: { dev: number; ino: number },
  identity: FileIdentity,
): boolean {
  return metadata.dev === identity.device && metadata.ino === identity.inode;
}

export async function captureNewFilePreviewState(
  snapshot: NewFilePreviewSnapshot,
): Promise<AttemptResult<NewFilePreviewState>> {
  return attempt(async () => {
    const ancestor = await lstat(snapshot.nearestExistingAncestorPath);
    if (!ancestor.isDirectory() || !isSameIdentity(ancestor, snapshot.ancestorIdentity)) {
      throw new Error(`The preview ancestor changed: ${snapshot.nearestExistingAncestorPath}`);
    }
    const directoryIdentities: NewFilePreviewState["directoryIdentities"] = [];
    for (const path of snapshot.missingDirectoryPaths) {
      const metadataAttempt = await attempt(() => lstat(path));
      if (!metadataAttempt.success) {
        if (isErrorWithCode({ error: metadataAttempt.error, code: "ENOENT" })) continue;
        throw metadataAttempt.error;
      }
      if (!metadataAttempt.value.isDirectory()) {
        throw new Error(`The preview parent is not a directory: ${path}`);
      }
      directoryIdentities.push({
        path,
        identity: { device: metadataAttempt.value.dev, inode: metadataAttempt.value.ino },
      });
    }
    const targetAttempt = await attempt(() => lstat(snapshot.canonicalPath));
    if (!targetAttempt.success && !isErrorWithCode({ error: targetAttempt.error, code: "ENOENT" })) {
      throw targetAttempt.error;
    }
    if (targetAttempt.success && !targetAttempt.value.isFile()) {
      throw new Error(`The preview target is not a regular file: ${snapshot.canonicalPath}`);
    }
    return {
      snapshot,
      directoryIdentities,
      targetIdentity: targetAttempt.success
        ? { device: targetAttempt.value.dev, inode: targetAttempt.value.ino }
        : undefined,
    };
  });
}

export async function restoreNewFilePreview(
  state: NewFilePreviewState,
): Promise<NewFileRestorationOutcome> {
  const issues: NewFileRestorationOutcome["issues"] = [];
  const ancestorAttempt = await attempt(() => lstat(state.snapshot.nearestExistingAncestorPath));
  if (!ancestorAttempt.success ||
      !ancestorAttempt.value.isDirectory() ||
      !isSameIdentity(ancestorAttempt.value, state.snapshot.ancestorIdentity)) {
    return {
      type: "incomplete",
      issues: [{
        path: state.snapshot.nearestExistingAncestorPath,
        reason: ancestorAttempt.success ? "identity-changed" : "failed",
        ...ancestorAttempt.success ? {} : { error: ancestorAttempt.error },
      }],
    };
  }
  // Validate shallow-to-deep before resolving or deleting descendants through a replaced parent.
  for (const path of state.snapshot.missingDirectoryPaths) {
    const metadataAttempt = await attempt(() => lstat(path));
    if (!metadataAttempt.success) {
      if (isErrorWithCode({ error: metadataAttempt.error, code: "ENOENT" })) {
        continue;
      }

      return { type: "incomplete", issues: [{ path, reason: "failed", error: metadataAttempt.error }] };
    }
    const recordedDirectory = state.directoryIdentities.find((directory) => {
      return directory.path === path;
    });
    if (recordedDirectory === undefined ||
        !metadataAttempt.value.isDirectory() ||
        !isSameIdentity(metadataAttempt.value, recordedDirectory.identity)) {
      return { type: "incomplete", issues: [{ path, reason: "identity-changed" }] };
    }
  }
  const targetPath = state.snapshot.canonicalPath;
  const targetAttempt = await attempt(() => lstat(targetPath));
  if (targetAttempt.success) {
    if (state.targetIdentity === undefined ||
        !targetAttempt.value.isFile() ||
        !isSameIdentity(targetAttempt.value, state.targetIdentity)) {
      issues.push({ path: targetPath, reason: "identity-changed" });
    } else {
      const removal = await attempt(() => unlink(targetPath));
      if (!removal.success && !isErrorWithCode({ error: removal.error, code: "ENOENT" })) {
        issues.push({ path: targetPath, reason: "failed", error: removal.error });
      }
    }
  } else if (!isErrorWithCode({ error: targetAttempt.error, code: "ENOENT" })) {
    issues.push({ path: targetPath, reason: "failed", error: targetAttempt.error });
  }
  for (const { path, identity } of [...state.directoryIdentities].reverse()) {
    const metadataAttempt = await attempt(() => lstat(path));
    if (!metadataAttempt.success) {
      if (!isErrorWithCode({ error: metadataAttempt.error, code: "ENOENT" })) {
        issues.push({ path, reason: "failed", error: metadataAttempt.error });
      }
      continue;
    }
    if (!metadataAttempt.value.isDirectory() || !isSameIdentity(metadataAttempt.value, identity)) {
      issues.push({ path, reason: "identity-changed" });
      continue;
    }
    const removal = await attempt(() => rmdir(path));
    if (!removal.success && !isErrorWithCode({ error: removal.error, code: "ENOENT" })) {
      const notEmpty = isErrorWithCode({ error: removal.error, code: "ENOTEMPTY" }) ||
        isErrorWithCode({ error: removal.error, code: "EEXIST" });
      issues.push({ path, reason: notEmpty ? "not-empty" : "failed", error: removal.error });
    }
  }
  return { type: issues.length === 0 ? "restored" : "incomplete", issues };
}
