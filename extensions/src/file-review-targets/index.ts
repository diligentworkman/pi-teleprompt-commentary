import { attempt, isErrorWithCode } from "#/errors/index.ts";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileReviewTargetClassification } from "./types.ts";

export type {
  ExistingFileReviewTarget,
  FileReviewTarget,
  FileReviewTargetClassification,
  NewFileReviewTarget,
} from "./types.ts";

export async function classifyFileReviewTarget(
  canonicalPath: string,
): Promise<FileReviewTargetClassification> {
  const targetAttempt = await attempt(() => lstat(canonicalPath));
  if (targetAttempt.success) {
    return attempt.value({ type: "existing", canonicalPath });
  }
  if (!isErrorWithCode({ error: targetAttempt.error, code: "ENOENT" })) {
    return attempt.error(targetAttempt.error);
  }
  const missingDirectoryPaths: Array<string> = [];
  let candidatePath = dirname(canonicalPath);
  while (true) {
    const candidateAttempt = await attempt(() => lstat(candidatePath));
    if (candidateAttempt.success) {
      return attempt.value({
        type: "new",
        canonicalPath,
        nearestExistingAncestorPath: candidatePath,
        missingDirectoryPaths,
      });
    }
    if (!isErrorWithCode({ error: candidateAttempt.error, code: "ENOENT" })) {
      return attempt.error(candidateAttempt.error);
    }
    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      return attempt.error(candidateAttempt.error);
    }
    missingDirectoryPaths.unshift(candidatePath);
    candidatePath = parentPath;
  }
}
