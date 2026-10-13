import { attempt, type AttemptResult } from "#/errors/index.ts";
import type { FilePreviewSnapshot } from "#/file-preview/index.ts";
import type {
  RuntimeTemporaryFile,
  RuntimeTemporaryFileStore,
} from "#/runtime-temporary-files/index.ts";

/** The editor's reference artifact is never used as the restoration source. */
export async function createOriginalContentArtifact({
  snapshot,
  temporaryFileStore,
}: {
  snapshot: FilePreviewSnapshot;
  temporaryFileStore: RuntimeTemporaryFileStore;
}): Promise<AttemptResult<RuntimeTemporaryFile | undefined>> {
  if (snapshot.type === "new") return attempt.value(undefined);
  return attempt(() => temporaryFileStore.createFile({
    kind: "original-content",
    content: snapshot.originalContent,
  }));
}
