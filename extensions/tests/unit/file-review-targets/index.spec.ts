import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { isErrorWithCode } from "#/errors/index.ts";
import { classifyFileReviewTarget } from "#/file-review-targets/index.ts";

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-file-targets-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

describe("file review target classification", () => {
  describe("when the target already exists", () => {
    it("returns the canonical target as existing when its filesystem entry already exists", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const canonicalPath = join(directory, "existing.txt");
      await writeFile(canonicalPath, "existing", "utf8");
      assert.deepEqual(await classifyFileReviewTarget(canonicalPath), {
        success: true,
        value: { type: "existing", canonicalPath },
        error: undefined,
      });
    });
  });
  describe("when the target does not yet exist", () => {
    it("classifies a missing target beneath an existing parent without recording missing directories", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const canonicalPath = join(directory, "new.txt");
      assert.deepEqual(await classifyFileReviewTarget(canonicalPath), {
        success: true,
        value: {
          type: "new",
          canonicalPath,
          nearestExistingAncestorPath: directory,
          missingDirectoryPaths: [],
        },
        error: undefined,
      });
    });
    it("records only missing parent directories in shallowest-to-deepest order", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const firstMissingDirectory = join(directory, "first");
      const secondMissingDirectory = join(firstMissingDirectory, "second");
      const canonicalPath = join(secondMissingDirectory, "new.txt");
      assert.deepEqual(await classifyFileReviewTarget(canonicalPath), {
        success: true,
        value: {
          type: "new",
          canonicalPath,
          nearestExistingAncestorPath: directory,
          missingDirectoryPaths: [
            firstMissingDirectory,
            secondMissingDirectory,
          ],
        },
        error: undefined,
      });
    });
  });
  describe("when the filesystem prevents reliable classification", () => {
    it("preserves ENOTDIR when an existing file prevents traversal to the target", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const filePath = join(directory, "file.txt");
      await writeFile(filePath, "content", "utf8");
      const classificationAttempt = await classifyFileReviewTarget(
        join(filePath, "new.txt"),
      );
      assert.equal(classificationAttempt.success, false);
      if (classificationAttempt.success) {
        assert.fail(
          "Expected classification to fail for a non-directory parent.",
        );
      }
      assert.equal(
        isErrorWithCode({
          error: classificationAttempt.error,
          code: "ENOTDIR",
        }),
        true,
      );
    });
    it("preserves an unexpected filesystem failure instead of classifying the target", async () => {
      const classificationAttempt = await classifyFileReviewTarget("\0");
      assert.equal(classificationAttempt.success, false);
      if (classificationAttempt.success) {
        assert.fail("Expected classification to fail for an invalid path.");
      }
      assert.ok(classificationAttempt.error instanceof TypeError);
      assert.equal(
        isErrorWithCode({
          error: classificationAttempt.error,
          code: "ERR_INVALID_ARG_VALUE",
        }),
        true,
      );
    });
  });
});
