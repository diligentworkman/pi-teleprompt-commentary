import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { captureFilePreviewSnapshot, restoreExistingFilePreview, runPiFilePreview } from "#/file-preview/index.ts";

const executeFile = promisify(execFile);

async function createTemporaryRoot(testContext: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teleprompt-pi-preview-"));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return realpath(root);
}

function createPreviewContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

async function captureSnapshotInChild(target: string): Promise<{ success: boolean; error?: string }> {
  const moduleUrl = new URL("../../../src/file-preview/index.ts", import.meta.url).href;
  const script = `
    const { captureFilePreviewSnapshot } = await import(${JSON.stringify(moduleUrl)});
    const snapshot = await captureFilePreviewSnapshot(${JSON.stringify(target)});
    console.log(JSON.stringify({ success: snapshot.success, error: snapshot.success ? undefined : String(snapshot.error) }));
  `;
  const { stdout } = await executeFile(process.execPath, ["--input-type=module", "--eval", script], {
    timeout: 10000,
    killSignal: "SIGKILL",
  });

  return JSON.parse(stdout);
}

describe("Pi-powered file preview", () => {
  describe("when capturing an existing target before preview", () => {
    it("rejects a FIFO without waiting for a writer or changing the target", { skip: process.platform === "win32" }, async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "proposal.fifo");
      await executeFile("mkfifo", [target], { timeout: 10000 });
      const before = await lstat(target);
      const snapshot = await captureSnapshotInChild(target);
      assert.deepEqual(snapshot, {
        success: false,
        error: `Error: The preview target is not a regular file: ${target}`,
      });
      const after = await lstat(target);
      assert.equal(after.isFIFO(), true);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
    });
    it("captures exact binary bytes and file metadata without changing the target", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "original.bin");
      const bytes = Buffer.from([0, 255, 10, 42]);
      await writeFile(target, bytes);
      const before = await stat(target);
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "existing") {
        assert.fail("Expected an existing-file snapshot.");
      }
      assert.equal(snapshot.value.canonicalPath, target);
      assert.deepEqual(snapshot.value.originalContent, bytes);
      assert.equal(snapshot.value.mode, before.mode & 0o7777);
      assert.equal(snapshot.value.modificationTime.getTime(), before.mtime.getTime());
      assert.equal(snapshot.value.accessTime.getTime(), before.atime.getTime());
      assert.deepEqual(await readFile(target), bytes);
    });

    it("returns a failure without mutating a directory target", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const snapshot = await captureFilePreviewSnapshot(root);
      assert.equal(snapshot.success, false);
      if (snapshot.success) assert.fail("Expected a non-file failure.");
      assert.match(String(snapshot.error), /not a regular file/);
    });
  });

  describe("when restoring an existing target after preview", () => {
    it("restores original bytes, mode, timestamps, and remains safe on repeated restoration", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "original.txt");
      const originalContent = Buffer.from([0, 255, 10, 42]);
      await writeFile(target, originalContent);
      await chmod(target, 0o600);
      const originalTime = new Date("2020-01-02T03:04:05.000Z");
      await utimes(target, originalTime, originalTime);
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "existing") {
        assert.fail("Expected an existing-file snapshot.");
      }
      await runPiFilePreview({
        preview: { toolName: "write", input: { path: target, content: "proposed text" } },
        toolCallId: "restore-write",
        ctx: createPreviewContext(root),
      });
      assert.deepEqual(await restoreExistingFilePreview(snapshot.value), { type: "restored" });
      assert.deepEqual(await restoreExistingFilePreview(snapshot.value), { type: "restored" });
      assert.deepEqual(await readFile(target), originalContent);
      const restored = await stat(target);
      if (process.platform !== "win32") {
        assert.equal(restored.mode & 0o7777, snapshot.value.mode);
      }
      assert.equal(restored.mtime.getTime(), originalTime.getTime());
    });

    it("leaves a replaced file untouched instead of overwriting it", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      const replacement = join(root, "replacement.txt");
      await writeFile(target, "original");
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "existing") {
        assert.fail("Expected an existing-file snapshot.");
      }
      await writeFile(replacement, "intervening replacement");
      await rename(replacement, target);
      assert.deepEqual(await restoreExistingFilePreview(snapshot.value), {
        type: "identity-changed",
      });
      assert.equal(await readFile(target, "utf8"), "intervening replacement");
    });

    it("preserves a replacement symlink to the moved original without restoring through it", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      const movedTarget = join(root, "moved-original.txt");
      const proposedContent = "proposed text must remain untouched";
      await writeFile(target, "original");
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "existing") {
        assert.fail("Expected an existing-file snapshot.");
      }
      await runPiFilePreview({
        preview: { toolName: "write", input: { path: target, content: proposedContent } },
        toolCallId: "restore-replaced-symlink",
        ctx: createPreviewContext(root),
      });
      await rename(target, movedTarget);
      await symlink(movedTarget, target, "file");
      const linkedFile = await stat(target);
      assert.equal(linkedFile.dev, snapshot.value.device);
      assert.equal(linkedFile.ino, snapshot.value.inode);
      assert.deepEqual(await restoreExistingFilePreview(snapshot.value), { type: "identity-changed" });
      assert.deepEqual(await restoreExistingFilePreview(snapshot.value), { type: "identity-changed" });
      assert.equal((await lstat(target)).isSymbolicLink(), true);
      assert.equal(await readFile(movedTarget, "utf8"), proposedContent);
      assert.equal(await readFile(target, "utf8"), proposedContent);
    });
    it("reports a deleted target as a restoration failure without recreating it", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      await writeFile(target, "original");
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "existing") {
        assert.fail("Expected an existing-file snapshot.");
      }
      await rm(target);
      const outcome = await restoreExistingFilePreview(snapshot.value);
      assert.equal(outcome.type, "failed");
      if (outcome.type !== "failed") assert.fail("Expected a restoration failure.");
      assert.equal((outcome.error as NodeJS.ErrnoException).code, "ENOENT");
      await assert.rejects(stat(target), { code: "ENOENT" });
    });
  });

  describe("when capturing a new target before preview", () => {
    it("records only initially missing parents in shallow-to-deep order without creating them", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const existing = join(root, "existing");
      await mkdir(existing);
      const target = join(existing, "first", "second", "new.txt");
      const snapshot = await captureFilePreviewSnapshot(target);
      assert.equal(snapshot.success, true);
      if (!snapshot.success || snapshot.value.type !== "new") {
        assert.fail("Expected a new-file snapshot.");
      }
      assert.equal(snapshot.value.nearestExistingAncestorPath, existing);
      assert.deepEqual(snapshot.value.missingDirectoryPaths, [
        join(existing, "first"), join(existing, "first", "second"),
      ]);
      await assert.rejects(stat(join(existing, "first")), { code: "ENOENT" });
    });
  });
  describe("when the original input calls Pi's built-in write definition", () => {
    it("writes exact content to a nested target relative to the current context cwd", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      await runPiFilePreview({
        preview: {
          toolName: "write",
          input: { path: "nested/target.txt", content: "proposed\n" },
        },
        toolCallId: "preview-write",
        ctx: createPreviewContext(root),
      });
      assert.equal(await readFile(join(root, "nested/target.txt"), "utf8"), "proposed\n");
    });

    it("passes through Pi's native abort error without creating the proposed file", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        runPiFilePreview({
          preview: {
            toolName: "write",
            input: { path: "aborted.txt", content: "must not appear" },
          },
          toolCallId: "preview-aborted-write",
          ctx: createPreviewContext(root),
          signal: controller.signal,
        }),
        /Operation aborted/,
      );
      await assert.rejects(readFile(join(root, "aborted.txt")), { code: "ENOENT" });
    });
  });

  describe("when the original input calls Pi's built-in edit definition", () => {
    it("applies Pi's exact replacement to an existing file relative to the current context cwd", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      await writeFile(target, "before\nkeep\n");
      await runPiFilePreview({
        preview: {
          toolName: "edit",
          input: {
            path: "target.txt",
            edits: [{ oldText: "before", newText: "after" }],
          },
        },
        toolCallId: "preview-edit",
        ctx: createPreviewContext(root),
      });
      assert.equal(await readFile(target, "utf8"), "after\nkeep\n");
    });

    it("preserves Pi's native failure when the requested text is absent", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      await writeFile(target, "unchanged\n");
      await assert.rejects(
        runPiFilePreview({
          preview: {
            toolName: "edit",
            input: {
              path: "target.txt",
              edits: [{ oldText: "missing", newText: "replacement" }],
            },
          },
          toolCallId: "preview-failed-edit",
          ctx: createPreviewContext(root),
        }),
        /Could not find the exact text in target\.txt/,
      );
      assert.equal(await readFile(target, "utf8"), "unchanged\n");
    });
  });
});
