import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { runRestoredPiFilePreview } from "#/file-preview/restored-preview.ts";

async function createTemporaryRoot(testContext: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teleprompt-restored-preview-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function previewContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

describe("restored Pi file preview", () => {
  describe("when the snapshot path and Pi's execution input refer to different targets", () => {
    it("rejects the mismatch before snapshotting or invoking Pi", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const expected = join(root, "original.txt");
      const other = join(root, "other.txt");
      await writeFile(expected, "original");
      let previewCalled = false;
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: expected,
        preview: { toolName: "write", input: { path: "other.txt", content: "proposal" } },
        toolCallId: "mismatched-target",
        ctx: previewContext(root),
        async runPreview() {
          previewCalled = true;
        },
      });
      assert.deepEqual(outcome, { type: "path-mismatch", resolvedPath: other });
      assert.equal(previewCalled, false);
      assert.equal(await readFile(expected, "utf8"), "original");
      await assert.rejects(stat(other), { code: "ENOENT" });
    });

    it("allows a relative path whose canonical destination matches the snapshot", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      await writeFile(target, "original");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: "./target.txt", content: "proposal" } },
        toolCallId: "relative-target",
        ctx: previewContext(root),
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.equal(await readFile(target, "utf8"), "original");
    });

    it("allows an existing symlink alias only when it resolves to the snapshotted target", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "target.txt");
      const alias = join(root, "alias.txt");
      await writeFile(target, "original");
      await symlink(target, alias);
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: alias, content: "proposal" } },
        toolCallId: "alias-target",
        ctx: previewContext(root),
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.equal(await readFile(target, "utf8"), "original");
    });

    it("preserves path-resolution errors without invoking Pi", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const parentFile = join(root, "not-a-directory");
      await writeFile(parentFile, "original");
      let previewCalled = false;
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: parentFile,
        preview: {
          toolName: "write",
          input: { path: join(parentFile, "child.txt"), content: "proposal" },
        },
        toolCallId: "unresolvable-target",
        ctx: previewContext(root),
        async runPreview() {
          previewCalled = true;
        },
      });
      assert.equal(outcome.type, "path-resolution-failed");
      assert.equal(previewCalled, false);
      assert.equal(await readFile(parentFile, "utf8"), "original");
    });
  });
  describe("when Pi writes to an existing file", () => {
    it("restores the original bytes after Pi writes its proposal", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original\n");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposed\n" } },
        toolCallId: "existing-write",
        ctx: previewContext(root),
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.equal(await readFile(target, "utf8"), "original\n");
    });

    it("exposes Pi's proposal for inspection, then restores the original file", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      let inspected = false;
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "inspect-existing",
        ctx: previewContext(root),
        async inspectProposal() {
          assert.equal(await readFile(target, "utf8"), "proposal");
          inspected = true;
        },
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.equal(inspected, true);
      assert.equal(await readFile(target, "utf8"), "original");
    });

    it("restores the original file even if inspection throws", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      const inspectionError = new Error("editor failed");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "failed-inspection",
        ctx: previewContext(root),
        async inspectProposal() {
          throw inspectionError;
        },
      });
      assert.deepEqual(outcome, { type: "inspection-failed", error: inspectionError });
      assert.equal(await readFile(target, "utf8"), "original");
    });

    it("restores an originally empty file after Pi's native write", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "empty.txt");
      await writeFile(target, "");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "empty-original",
        ctx: previewContext(root),
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.equal(await readFile(target, "utf8"), "");
    });

    it("restores partial changes and preserves the exact preview failure", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      const previewError = { reason: "failed after writing" };
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "partial-existing",
        ctx: previewContext(root),
        async runPreview() {
          await writeFile(target, "partial");
          throw previewError;
        },
      });
      assert.deepEqual(outcome, { type: "preview-failed", error: previewError });
      assert.equal(await readFile(target, "utf8"), "original");
    });

    it("returns Pi's native edit failure and leaves original content intact", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original\n");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: {
          toolName: "edit",
          input: { path: target, edits: [{ oldText: "absent", newText: "new" }] },
        },
        toolCallId: "failed-edit",
        ctx: previewContext(root),
      });
      assert.equal(outcome.type, "preview-failed");
      if (outcome.type !== "preview-failed") assert.fail("Expected Pi's native failure.");
      assert.match(String(outcome.error), /Could not find the exact text/);
      assert.equal(await readFile(target, "utf8"), "original\n");
    });
  });

  describe("when Pi writes a new file", () => {
    it("removes the proposal and only initially missing parents", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "deeper", "new.txt");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "new\n" } },
        toolCallId: "new-write",
        ctx: previewContext(root),
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.deepEqual(await readdir(root), []);
    });

    it("inspects the proposal before removing it and its new parent", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "new.txt");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "inspect-new",
        ctx: previewContext(root),
        async inspectProposal() {
          assert.equal(await readFile(target, "utf8"), "proposal");
        },
      });
      assert.deepEqual(outcome, { type: "previewed" });
      assert.deepEqual(await readdir(root), []);
    });

    it("removes a new proposal even if inspection throws", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "new.txt");
      const inspectionError = new Error("editor failed");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "failed-new-inspection",
        ctx: previewContext(root),
        async inspectProposal() {
          throw inspectionError;
        },
      });
      assert.deepEqual(outcome, { type: "inspection-failed", error: inspectionError });
      assert.deepEqual(await readdir(root), []);
    });

    it("removes parents created before a preview failure and preserves the exact error", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "deeper", "new.txt");
      const previewError = new Error("failed after directory creation");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "partial-new",
        ctx: previewContext(root),
        async runPreview() {
          await mkdir(join(root, "nested", "deeper"), { recursive: true });
          throw previewError;
        },
      });
      assert.deepEqual(outcome, { type: "preview-failed", error: previewError });
      assert.deepEqual(await readdir(root), []);
    });

    it("reports incomplete cleanup separately from a preview failure when intervening content remains", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "new.txt");
      const unrelated = join(root, "nested", "unrelated.txt");
      const previewError = new Error("preview failed");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "incomplete-cleanup",
        ctx: previewContext(root),
        async runPreview() {
          await mkdir(join(root, "nested"));
          await writeFile(unrelated, "keep");
          throw previewError;
        },
      });
      assert.equal(outcome.type, "restoration-incomplete");
      if (outcome.type !== "restoration-incomplete") assert.fail("Expected incomplete cleanup.");
      assert.deepEqual(outcome.preview, { type: "failed", error: previewError });
      assert.equal(outcome.restoration.type, "incomplete");
      assert.equal(await readFile(unrelated, "utf8"), "keep");
    });

    it("reports unconfirmed cleanup if a preview leaves a non-regular target", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "new.txt");
      const previewError = new Error("preview failed after replacing the target");
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "unsafe-target",
        ctx: previewContext(root),
        async runPreview() {
          await symlink(root, target);
          throw previewError;
        },
      });
      assert.equal(outcome.type, "cleanup-unconfirmed");
      if (outcome.type !== "cleanup-unconfirmed") assert.fail("Expected unconfirmed cleanup.");
      assert.deepEqual(outcome.preview, { type: "failed", error: previewError });
      assert.match(String(outcome.error), /not a regular file/);
      assert.equal((await stat(target)).isDirectory(), true);
    });

    it("reports Pi's native abort while leaving no new file or parent directory", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const target = join(root, "nested", "aborted.txt");
      const controller = new AbortController();
      controller.abort();
      const outcome = await runRestoredPiFilePreview({
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "new" } },
        toolCallId: "aborted-write",
        ctx: previewContext(root),
        signal: controller.signal,
      });
      assert.equal(outcome.type, "preview-failed");
      if (outcome.type !== "preview-failed") assert.fail("Expected Pi's abort error.");
      assert.match(String(outcome.error), /Operation aborted/);
      assert.deepEqual(await readdir(root), []);
      await assert.rejects(stat(target), { code: "ENOENT" });
    });
  });
});
