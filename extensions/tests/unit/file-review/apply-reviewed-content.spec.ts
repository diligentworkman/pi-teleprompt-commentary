import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { applyReviewedFileContent } from "#/file-review/apply-reviewed-content.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-file-apply-")));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("applying reviewed file content", () => {
  it("atomically replaces an existing file with exact bytes while preserving its mode", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    await chmod(target, 0o640);
    const originalIdentity = await lstat(target);
    const content = Buffer.from([0, 255, 10]);
    const result = await applyReviewedFileContent({ canonicalPath: target, content });
    assert.equal(result.success, true);
    assert.deepEqual(await readFile(target), content);
    assert.equal((await lstat(target)).mode & 0o777, 0o640);
    assert.notEqual((await lstat(target)).ino, originalIdentity.ino);
    assert.deepEqual(await readdir(root), ["existing.txt"]);
  });

  it("creates an empty reviewed new file when the normal tool left no target", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "new.txt");
    const result = await applyReviewedFileContent({ canonicalPath: target, content: Buffer.alloc(0) });
    assert.equal(result.success, true);
    assert.deepEqual(await readFile(target), Buffer.alloc(0));
    assert.deepEqual(await readdir(root), ["new.txt"]);
  });

  it("does not follow or overwrite a symlink target", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "target.txt");
    const symlinkPath = join(root, "alias.txt");
    await writeFile(target, "original");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, symlinkPath);
    const result = await applyReviewedFileContent({ canonicalPath: symlinkPath, content: Buffer.from("reviewed") });
    assert.equal(result.success, false);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  });

  it("reports missing parents without leaving temporary files", async (testContext) => {
    const root = await fixture(testContext);
    const result = await applyReviewedFileContent({
      canonicalPath: join(root, "missing", "file.txt"),
      content: Buffer.from("reviewed"),
    });
    assert.equal(result.success, false);
    assert.deepEqual(await readdir(root), []);
  });
});
