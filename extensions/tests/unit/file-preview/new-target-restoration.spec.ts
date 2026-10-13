import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { captureFilePreviewSnapshot, runPiFilePreview } from "#/file-preview/index.ts";
import {
  captureNewFilePreviewState,
  restoreNewFilePreview,
} from "#/file-preview/new-target-restoration.ts";

async function createTemporaryRoot(testContext: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teleprompt-new-preview-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function captureNewTarget(path: string) {
  const result = await captureFilePreviewSnapshot(path);
  assert.equal(result.success, true);
  if (!result.success || result.value.type !== "new") {
    assert.fail("Expected a new-target snapshot.");
  }
  return result.value;
}

async function captureAfterPreview(snapshot: Awaited<ReturnType<typeof captureNewTarget>>) {
  const result = await captureNewFilePreviewState(snapshot);
  assert.equal(result.success, true);
  if (!result.success) assert.fail("Expected captured preview identities.");
  return result.value;
}

async function runNewWrite(root: string, path: string) {
  await runPiFilePreview({
    preview: { toolName: "write", input: { path, content: "proposed" } },
    ctx: { cwd: root } as ExtensionContext,
    toolCallId: "new-preview",
  });
}

describe("new-target file preview restoration", () => {
  describe("when Pi creates a target beneath initially missing parents", () => {
    it("removes the preview file and only its originally missing empty parents in deepest-first order", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const existing = join(root, "existing");
      await mkdir(existing);
      const target = join(existing, "one", "two", "new.txt");
      const snapshot = await captureNewTarget(target);
      await runNewWrite(root, target);
      const state = await captureAfterPreview(snapshot);
      assert.equal(state.directoryIdentities.length, 2);
      assert.deepEqual(await restoreNewFilePreview(state), { type: "restored", issues: [] });
      assert.deepEqual(await restoreNewFilePreview(state), { type: "restored", issues: [] });
      assert.deepEqual(await readdir(existing), []);
      assert.equal((await stat(existing)).isDirectory(), true);
    });

    it("retains an initially missing parent with intervening content while removing the preview target", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "first", "second", "new.txt");
      const snapshot = await captureNewTarget(target);
      await runNewWrite(root, target);
      const state = await captureAfterPreview(snapshot);
      const unrelated = join(root, "first", "second", "unrelated.txt");
      await writeFile(unrelated, "keep");
      const restoration = await restoreNewFilePreview(state);
      assert.equal(restoration.type, "incomplete");
      assert.deepEqual(restoration.issues.map(({ path, reason }) => ({ path, reason })), [
        { path: dirname(target), reason: "not-empty" },
        { path: join(root, "first"), reason: "not-empty" },
      ]);
      assert.equal(await readFile(unrelated, "utf8"), "keep");
      await assert.rejects(stat(target), { code: "ENOENT" });
    });

    it("retains a replaced target instead of unlinking an untracked file", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "new.txt");
      const replacement = join(root, "replacement.txt");
      const snapshot = await captureNewTarget(target);
      await runNewWrite(root, target);
      const state = await captureAfterPreview(snapshot);
      await writeFile(replacement, "keep replacement");
      await rename(replacement, target);
      assert.deepEqual(await restoreNewFilePreview(state), {
        type: "incomplete",
        issues: [{ path: target, reason: "identity-changed" }],
      });
      assert.equal(await readFile(target, "utf8"), "keep replacement");
    });

    it("retains a replaced intermediate directory and all content beneath it", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "parent", "new.txt");
      const snapshot = await captureNewTarget(target);
      await runNewWrite(root, target);
      const state = await captureAfterPreview(snapshot);
      const originalParent = join(root, "old-parent");
      await rename(dirname(target), originalParent);
      await mkdir(dirname(target));
      await writeFile(target, "intervening content");
      const restoration = await restoreNewFilePreview(state);
      assert.equal(restoration.type, "incomplete");
      assert.deepEqual(restoration.issues.map(({ path, reason }) => ({ path, reason })), [
        { path: dirname(target), reason: "identity-changed" },
      ]);
      assert.equal(await readFile(target, "utf8"), "intervening content");
      assert.equal(await readFile(join(originalParent, "new.txt"), "utf8"), "proposed");
    });
  });

  describe("when a recorded parent is replaced by a symlink to the moved preview directory", () => {
    for (const depth of ["outer", "inner"] as const) {
      it(`preserves the moved target and all descendants on repeated restoration after an ${depth} parent replacement`, async (testContext) => {
        const root = await createTemporaryRoot(testContext);
        const outerParent = join(root, "parent");
        const innerParent = join(outerParent, "child");
        const target = join(innerParent, "new.txt");
        const snapshot = await captureNewTarget(target);
        await runNewWrite(root, target);
        const state = await captureAfterPreview(snapshot);
        const replacedParent = depth === "outer" ? outerParent : innerParent;
        const movedParent = join(root, "moved-parent");
        const movedTarget = depth === "outer" ? join(movedParent, "child", "new.txt") : join(movedParent, "new.txt");
        await rename(replacedParent, movedParent);
        await symlink(movedParent, replacedParent, "junction");
        const linkedTarget = await stat(target);
        assert.equal(linkedTarget.dev, state.targetIdentity?.device);
        assert.equal(linkedTarget.ino, state.targetIdentity?.inode);
        const expectedOutcome = {
          type: "incomplete",
          issues: [{ path: replacedParent, reason: "identity-changed" }],
        };
        assert.deepEqual(await restoreNewFilePreview(state), expectedOutcome);
        assert.deepEqual(await restoreNewFilePreview(state), expectedOutcome);
        assert.equal((await lstat(replacedParent)).isSymbolicLink(), true);
        assert.equal((await stat(innerParent)).isDirectory(), true);
        assert.equal(await readFile(movedTarget, "utf8"), "proposed");
        assert.equal(await readFile(target, "utf8"), "proposed");
      });
    }
  });
  describe("when Pi fails before creating the target", () => {
    it("preserves an untracked parent and its target created after preview-state capture", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const parent = join(root, "parent");
      const target = join(parent, "new.txt");
      const snapshot = await captureNewTarget(target);
      const state = await captureAfterPreview(snapshot);
      assert.deepEqual(state.directoryIdentities, []);
      await mkdir(parent);
      await writeFile(target, "intervening content");
      assert.deepEqual(await restoreNewFilePreview(state), {
        type: "incomplete",
        issues: [{ path: parent, reason: "identity-changed" }],
      });
      assert.equal((await stat(parent)).isDirectory(), true);
      assert.equal(await readFile(target, "utf8"), "intervening content");
    });
    it("records no target identity and leaves a subsequently created file untouched", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "new.txt");
      const snapshot = await captureNewTarget(target);
      const state = await captureAfterPreview(snapshot);
      assert.equal(state.targetIdentity, undefined);
      await writeFile(target, "intervening content");
      assert.deepEqual(await restoreNewFilePreview(state), {
        type: "incomplete",
        issues: [{ path: target, reason: "identity-changed" }],
      });
      assert.equal(await readFile(target, "utf8"), "intervening content");
    });
  });
});
