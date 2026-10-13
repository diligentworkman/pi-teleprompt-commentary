import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { prepareFileReview } from "#/file-review/policy-preparation.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-file-policy-")));
  const store = createRuntimeTemporaryFileStore({ temporaryRootPath: root, createFileId: () => "original" });
  testContext.after(async () => { await store.cleanup(); await rm(root, { recursive: true, force: true }); });
  return { root, store };
}

describe("file review policy preparation", () => {
  it("resolves diff editor with the actual target and an exact original-byte artifact", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    const original = Buffer.from([0, 255, 10]);
    await writeFile(target, original);
    const result = await prepareFileReview({
      canonicalPath: target,
      temporaryFileStore: store,
      async resolveConfiguredAction(input) {
        assert.equal(input.type, "existing");
        if (input.type !== "existing") assert.fail("Expected diff paths");
        assert.equal(input.newContentFilePath, target);
        assert.deepEqual(await readFile(input.oldContentFilePath), original);
        return ["editor", "--wait", input.oldContentFilePath, input.newContentFilePath];
      },
    });
    assert.equal(result.type, "prepared");
    if (result.type !== "prepared") assert.fail("Expected prepared review");
    assert.equal(result.value.snapshot.type, "existing");
    assert.deepEqual(result.value.policy, ["editor", "--wait", result.value.originalContentFile?.path, target]);
    await result.value.originalContentFile?.cleanup();
    assert.deepEqual(await readFile(target), original);
  });

  it("resolves a new-file editor without creating an original-content artifact", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "nested", "new.txt");
    const result = await prepareFileReview({
      canonicalPath: target,
      temporaryFileStore: store,
      async resolveConfiguredAction(input) {
        assert.deepEqual(input, { type: "new", newFilePath: target });
        return undefined;
      },
    });
    assert.equal(result.type, "prepared");
    if (result.type !== "prepared") assert.fail("Expected prepared review");
    assert.equal(result.value.policy, "prompt");
    assert.equal(result.value.originalContentFile, undefined);
    await assert.rejects(stat(target), { code: "ENOENT" });
  });

  it("cleans the original artifact if handler resolution fails", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    let artifactPath = "";
    const error = new Error("handler failed");
    const result = await prepareFileReview({
      canonicalPath: target,
      temporaryFileStore: store,
      async resolveConfiguredAction(input) {
        if (input.type !== "existing") assert.fail("Expected diff paths");
        artifactPath = input.oldContentFilePath;
        throw error;
      },
    });
    assert.deepEqual(result, { type: "failed", error });
    await assert.rejects(stat(artifactPath), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), "original");
  });
});
