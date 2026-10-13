import type { ResolvedAction } from "#/config-loader/index.ts";
import { attempt } from "#/errors/index.ts";
import { captureFilePreviewSnapshot, type FilePreviewSnapshot } from "#/file-preview/index.ts";
import { resolveReviewPolicy, type ReviewPolicy } from "#/review-policies/index.ts";
import type { RuntimeTemporaryFile, RuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";
import { createOriginalContentArtifact } from "./original-content.ts";

export type PreparedFileReview = {
  snapshot: FilePreviewSnapshot;
  policy: ReviewPolicy;
  originalContentFile?: RuntimeTemporaryFile;
};

export type PrepareFileReviewOutcome =
  | { type: "prepared"; value: PreparedFileReview }
  | { type: "failed"; error: unknown; cleanupError?: unknown };

export async function prepareFileReview({
  canonicalPath,
  temporaryFileStore,
  resolveConfiguredAction,
}: {
  canonicalPath: string;
  temporaryFileStore: RuntimeTemporaryFileStore;
  resolveConfiguredAction(input:
    | { type: "existing"; oldContentFilePath: string; newContentFilePath: string }
    | { type: "new"; newFilePath: string }
  ): Promise<ResolvedAction | undefined>;
}): Promise<PrepareFileReviewOutcome> {
  const snapshot = await captureFilePreviewSnapshot(canonicalPath);
  if (!snapshot.success) return { type: "failed", error: snapshot.error };
  const artifact = await createOriginalContentArtifact({
    snapshot: snapshot.value,
    temporaryFileStore,
  });
  if (!artifact.success) return { type: "failed", error: artifact.error };
  const originalContentFile = artifact.value;
  const action = await attempt(() => resolveConfiguredAction(
    snapshot.value.type === "existing"
      ? {
          type: "existing",
          oldContentFilePath: originalContentFile!.path,
          newContentFilePath: canonicalPath,
        }
      : { type: "new", newFilePath: canonicalPath },
  ));
  if (!action.success) {
    const cleanup = originalContentFile === undefined
      ? attempt.value(undefined)
      : await attempt(() => originalContentFile.cleanup());
    return {
      type: "failed",
      error: action.error,
      ...cleanup.success ? {} : { cleanupError: cleanup.error },
    };
  }
  return {
    type: "prepared",
    value: {
      snapshot: snapshot.value,
      policy: resolveReviewPolicy({ subject: "file", configuredAction: action.value }),
      ...(originalContentFile === undefined ? {} : { originalContentFile }),
    },
  };
}
