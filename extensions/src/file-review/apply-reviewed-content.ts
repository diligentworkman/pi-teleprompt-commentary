import { attempt, attemptWithCleanup, isErrorWithCode, type AttemptResult } from "#/errors/index.ts";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function applyReviewedFileContent({
  canonicalPath,
  content,
}: {
  canonicalPath: string;
  content: Buffer;
}): Promise<AttemptResult<void>> {
  const existing = await attempt(() => lstat(canonicalPath));
  if (!existing.success && !isErrorWithCode({ error: existing.error, code: "ENOENT" })) {
    return attempt.error(existing.error);
  }
  if (existing.success && !existing.value.isFile()) {
    return attempt.error(new Error(`The reviewed target is not a regular file: ${canonicalPath}`));
  }
  const temporaryPath = join(dirname(canonicalPath), `.${basename(canonicalPath)}.tc-${randomUUID()}.tmp`);
  let ownsTemporaryFile = false;
  const replacement = await attempt(async () => {
    const handle = await open(temporaryPath, "wx", 0o600);
    ownsTemporaryFile = true;
    const prepared = await attemptWithCleanup({
      operation() {
        return handle.writeFile(content);
      },
      cleanup() {
        return handle.close();
      },
    });
    if (!prepared.success) {
      throw prepared.error;
    }
    if (existing.success) {
      await chmod(temporaryPath, existing.value.mode & 0o7777);
    }
    // Same-filesystem rename normally provides atomic replacement. A concurrent replacement between
    // lstat and rename remains a documented TOCTOU limitation, not a lock.
    await rename(temporaryPath, canonicalPath);
  });
  if (!replacement.success && ownsTemporaryFile) {
    await attempt(() => rm(temporaryPath, { force: true }));
  }
  return replacement;
}
