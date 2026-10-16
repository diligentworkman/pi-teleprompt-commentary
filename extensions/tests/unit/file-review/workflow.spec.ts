import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt } from "#/errors/index.ts";
import { prepareFileReview, reviewPreparedFile } from "#/file-review/index.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-file-workflow-")));
  const store = createRuntimeTemporaryFileStore({ temporaryRootPath: root, createFileId: () => "original" });
  testContext.after(async () => { await store.cleanup(); await rm(root, { recursive: true, force: true }); });
  return { root, store };
}

function editorProcess(target: string, reviewedContent: string): ProcessRunner {
  return {
    start() {
      return {
        completion: writeFile(target, reviewedContent).then(() => ({ type: "exited" as const, exitCode: 0, signal: null })),
        async terminate() { return { type: "termination-observed" }; },
      };
    },
    async cleanup() { return []; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("prepared file review composition", () => {
  const singleLineSummary = "User review changes (agent proposal → reviewed content; line numbers refer to those versions):\n- Modified: proposal line 1 → reviewed line 1";
  for (const failed of [false, true]) {
    it(`cleans the original artifact exactly once after ${failed ? "review failure" : "successful review"}`, async (testContext) => {
      const { root, store } = await fixture(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      const prepared = await prepareFileReview({
        canonicalPath: target, temporaryFileStore: store,
        async resolveConfiguredAction() { return ["editor", target]; },
      });
      if (prepared.type !== "prepared" || prepared.value.originalContentFile === undefined) assert.fail("Expected original artifact");
      const artifact = prepared.value.originalContentFile;
      let cleanupCount = 0;
      prepared.value.originalContentFile = {
        path: artifact.path,
        async cleanup() { cleanupCount++; await artifact.cleanup(); },
      };
      const outcome = await reviewPreparedFile({
        prepared: prepared.value,
        input: {
          canonicalPath: target,
          preview: { toolName: "write", input: { path: target, content: "proposal" } },
          toolCallId: "cleanup-count", ctx: { cwd: root } as ExtensionContext, hasUI: false,
        },
        dependencies: {
          processRunner: failed ? {
            start() { throw new Error("editor startup failed"); },
            async cleanup() { return []; },
          } : editorProcess(target, "reviewed"),
          async requestDecision() { assert.fail("No UI"); },
          async requestFeedback() { assert.fail("No UI"); },
        },
      });
      assert.equal(outcome.type, failed ? "blocked" : "reviewed");
      assert.equal(cleanupCount, 1);
      assert.equal(await readFile(target, "utf8"), "original");
      await assert.rejects(readFile(artifact.path), { code: "ENOENT" });
    });
  }
  it("blocks prompt acceptance if editor termination is unconfirmed, while attempting best-effort restoration", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const prepared = await prepareFileReview({
      canonicalPath: target, temporaryFileStore: store,
      async resolveConfiguredAction() { return ["editor", target]; },
    });
    if (prepared.type !== "prepared") assert.fail("Expected prepared review");
    const outcome = await reviewPreparedFile({
      prepared: prepared.value,
      input: {
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "unconfirmed", ctx: { cwd: root } as ExtensionContext, hasUI: true,
      },
      dependencies: {
        processRunner: {
          start() {
            return {
              completion: new Promise(() => {}),
              async terminate() { return { type: "termination-unconfirmed" }; },
            };
          },
          async cleanup() { return []; },
        },
        async requestDecision() { return { type: "accepted" }; },
        async requestFeedback() { return undefined; },
      },
    });
    assert.equal(outcome.type, "blocked");
    if (outcome.type !== "blocked") assert.fail("Unconfirmed editor must block");
    assert.match(outcome.reason, /termination could not be confirmed/);
    assert.equal(await readFile(target, "utf8"), "original");
  });
  for (const accepted of [true, false]) {
    it(`waits for confirmed editor termination before restoring a prompt-${accepted ? "accepted" : "rejected"} proposal`, async (testContext) => {
      const { root, store } = await fixture(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      const prepared = await prepareFileReview({
        canonicalPath: target, temporaryFileStore: store,
        async resolveConfiguredAction() { return ["editor", target]; },
      });
      if (prepared.type !== "prepared") assert.fail("Expected prepared review");
      const terminating = deferred<void>();
      const stopped = deferred<void>();
      let terminationCount = 0;
      const processRunner: ProcessRunner = {
        start() {
          return {
            completion: new Promise<ProcessCompletion>(() => {}),
            async terminate() {
              terminationCount++;
              terminating.resolve();
              await stopped.promise;
              return { type: "termination-observed" };
            },
          };
        },
        async cleanup() { return []; },
      };
      const review = reviewPreparedFile({
        prepared: prepared.value,
        input: {
          canonicalPath: target,
          preview: { toolName: "write", input: { path: target, content: "proposal" } },
          toolCallId: "prompt-first", ctx: { cwd: root } as ExtensionContext, hasUI: true,
        },
        dependencies: {
          processRunner,
          async requestDecision() { return { type: accepted ? "accepted" : "rejected" }; },
          async requestFeedback() { return "user note"; },
        },
      });
      await terminating.promise;
      assert.equal(await readFile(target, "utf8"), "proposal");
      stopped.resolve();
      const outcome = await review;
      assert.deepEqual(outcome, accepted
        ? { type: "allowed", feedback: "user note" }
        : { type: "blocked", reason: "Tool call rejected by user: user note" });
      assert.equal(terminationCount, 1);
      assert.equal(await readFile(target, "utf8"), "original");
    });
  }

  it("captures editor-first bytes and aborts the outstanding Pi prompt before restoration", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const prepared = await prepareFileReview({
      canonicalPath: target, temporaryFileStore: store,
      async resolveConfiguredAction() { return ["editor", target]; },
    });
    if (prepared.type !== "prepared") assert.fail("Expected prepared review");
    let promptSignal: AbortSignal | undefined;
    const outcome = await reviewPreparedFile({
      prepared: prepared.value,
      input: {
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "editor-first", ctx: { cwd: root } as ExtensionContext, hasUI: true,
      },
      dependencies: {
        processRunner: editorProcess(target, "reviewed"),
        requestDecision({ signal }) {
          promptSignal = signal;
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve({ type: "superseded" }), { once: true });
          });
        },
        async requestFeedback() { assert.fail("No feedback after external decision"); },
      },
    });
    assert.deepEqual(outcome, {
      type: "reviewed",
      content: Buffer.from("reviewed"),
      changeSummary: attempt.value(singleLineSummary),
    });
    assert.equal(promptSignal?.aborted, true);
    assert.equal(await readFile(target, "utf8"), "original");
  });

  it("restores the proposal after caller cancellation and confirmed editor termination", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const prepared = await prepareFileReview({
      canonicalPath: target, temporaryFileStore: store,
      async resolveConfiguredAction() { return ["editor", target]; },
    });
    if (prepared.type !== "prepared") assert.fail("Expected prepared review");
    const started = deferred<void>();
    const controller = new AbortController();
    let terminationCount = 0;
    const outcomePromise = reviewPreparedFile({
      prepared: prepared.value,
      input: {
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "cancelled", ctx: { cwd: root } as ExtensionContext, hasUI: false,
        signal: controller.signal,
      },
      dependencies: {
        processRunner: {
          start() {
            started.resolve();
            return {
              completion: new Promise<ProcessCompletion>(() => {}),
              async terminate() { terminationCount++; return { type: "termination-observed" }; },
            };
          },
          async cleanup() { return []; },
        },
        async requestDecision() { assert.fail("No UI"); },
        async requestFeedback() { assert.fail("No UI"); },
      },
    });
    await started.promise;
    controller.abort();
    assert.deepEqual(await outcomePromise, { type: "blocked", reason: "The file review was cancelled." });
    assert.equal(terminationCount, 1);
    assert.equal(await readFile(target, "utf8"), "original");
  });
  it("reviews Pi's proposal and returns changed bytes after restoring original bytes", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const prepared = await prepareFileReview({
      canonicalPath: target,
      temporaryFileStore: store,
      async resolveConfiguredAction(input) {
        assert.equal(input.type, "existing");
        return ["editor", "--wait", target];
      },
    });
    assert.equal(prepared.type, "prepared");
    if (prepared.type !== "prepared") assert.fail("Expected prepared review");
    const result = await reviewPreparedFile({
      prepared: prepared.value,
      input: {
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "review-existing",
        ctx: { cwd: root } as ExtensionContext,
        hasUI: false,
      },
      dependencies: {
        processRunner: editorProcess(target, "reviewed"),
        async requestDecision() { assert.fail("No UI prompt"); },
        async requestFeedback() { assert.fail("No UI feedback"); },
      },
    });
    assert.deepEqual(result, {
      type: "reviewed",
      content: Buffer.from("reviewed"),
      changeSummary: attempt.value(singleLineSummary),
    });
    assert.equal(await readFile(target, "utf8"), "original");
  });

  describe("when capturing review change summaries", () => {
    it("compares the user-reviewed content against the agent proposal rather than the original target", async (testContext) => {
      const { root, store } = await fixture(testContext);
      const target = join(root, "existing.txt");
      const original = "original target\n";
      const proposal = "keep\nagent\n";
      const reviewed = "keep\nuser\nextra\n";
      await writeFile(target, original);
      const prepared = await prepareFileReview({
        canonicalPath: target,
        temporaryFileStore: store,
        async resolveConfiguredAction() {
          return ["editor", target];
        },
      });
      if (prepared.type !== "prepared") {
        assert.fail("Expected prepared review");
      }
      const result = await reviewPreparedFile({
        prepared: prepared.value,
        input: {
          canonicalPath: target,
          preview: { toolName: "write", input: { path: target, content: proposal } },
          toolCallId: "summary-baseline",
          ctx: { cwd: root } as ExtensionContext,
          hasUI: false,
        },
        dependencies: {
          processRunner: editorProcess(target, reviewed),
          async requestDecision() { assert.fail("No UI prompt"); },
          async requestFeedback() { assert.fail("No UI feedback"); },
        },
      });
      assert.deepEqual(result, {
        type: "reviewed",
        content: Buffer.from(reviewed),
        changeSummary: attempt.value(
          "User review changes (agent proposal → reviewed content; line numbers refer to those versions):\n- Modified: proposal line 2 → reviewed lines 2–3",
        ),
      });
      assert.equal(await readFile(target, "utf8"), original);
    });
    for (const { name, error } of [
      { name: "an Error instance", error: new Error("summary failed") },
      { name: "a non-Error object", error: { reason: "summary failed" } },
      { name: "undefined", error: undefined },
    ]) {
      it(`retains reviewed bytes and the exact thrown value when summary generation throws ${name}, while restoring and cleaning up`, async (testContext) => {
        const { root, store } = await fixture(testContext);
        const target = join(root, "existing.txt");
        const original = "original";
        const reviewed = "reviewed";
        await writeFile(target, original);
        const prepared = await prepareFileReview({
          canonicalPath: target,
          temporaryFileStore: store,
          async resolveConfiguredAction() {
            return ["editor", target];
          },
        });
        if (prepared.type !== "prepared" || prepared.value.originalContentFile === undefined) {
          assert.fail("Expected original-content artifact");
        }
        const artifact = prepared.value.originalContentFile;
        let cleanupCount = 0;
        prepared.value.originalContentFile = {
          path: artifact.path,
          async cleanup() {
            cleanupCount += 1;
            await artifact.cleanup();
          },
        };
        const result = await reviewPreparedFile({
          prepared: prepared.value,
          input: {
            canonicalPath: target,
            preview: { toolName: "write", input: { path: target, content: "proposal" } },
            toolCallId: "summary-failure",
            ctx: { cwd: root } as ExtensionContext,
            hasUI: false,
          },
          dependencies: {
            processRunner: editorProcess(target, reviewed),
            async requestDecision() { assert.fail("No UI prompt"); },
            async requestFeedback() { assert.fail("No UI feedback"); },
            summarizeChanges() {
              throw error;
            },
          },
        });
        assert.equal(result.type, "reviewed");
        if (result.type !== "reviewed") {
          assert.fail("Summary failure must not block reviewed content");
        }
        assert.deepEqual(result.content, Buffer.from(reviewed));
        assert.equal(result.changeSummary.success, false);
        assert.equal(result.changeSummary.error, error);
        assert.equal(await readFile(target, "utf8"), original);
        assert.equal(cleanupCount, 1);
        await assert.rejects(readFile(artifact.path), { code: "ENOENT" });
      });
    }
    it("accepts an unchanged editor result without generating a summary", async (testContext) => {
      const { root, store } = await fixture(testContext);
      const target = join(root, "existing.txt");
      const proposal = "proposal";
      await writeFile(target, "original");
      const prepared = await prepareFileReview({
        canonicalPath: target,
        temporaryFileStore: store,
        async resolveConfiguredAction() {
          return ["editor", target];
        },
      });
      if (prepared.type !== "prepared") {
        assert.fail("Expected prepared review");
      }
      let summaryCalls = 0;
      const result = await reviewPreparedFile({
        prepared: prepared.value,
        input: {
          canonicalPath: target,
          preview: { toolName: "write", input: { path: target, content: proposal } },
          toolCallId: "unchanged-summary",
          ctx: { cwd: root } as ExtensionContext,
          hasUI: false,
        },
        dependencies: {
          processRunner: editorProcess(target, proposal),
          async requestDecision() { assert.fail("No UI prompt"); },
          async requestFeedback() { assert.fail("No UI feedback"); },
          summarizeChanges() {
            summaryCalls += 1;
            throw new Error("Unchanged reviews must not generate summaries");
          },
        },
      });
      assert.deepEqual(result, { type: "allowed" });
      assert.equal(summaryCalls, 0);
      assert.equal(await readFile(target, "utf8"), "original");
    });
  });

  it("blocks if the prepared snapshot is stale without overwriting intervening content", async (testContext) => {
    const { root, store } = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const prepared = await prepareFileReview({
      canonicalPath: target,
      temporaryFileStore: store,
      async resolveConfiguredAction() { return ["editor", target]; },
    });
    if (prepared.type !== "prepared") assert.fail("Expected prepared review");
    await writeFile(target, "intervening");
    const result = await reviewPreparedFile({
      prepared: prepared.value,
      input: {
        canonicalPath: target,
        preview: { toolName: "write", input: { path: target, content: "proposal" } },
        toolCallId: "stale-existing",
        ctx: { cwd: root } as ExtensionContext,
        hasUI: false,
      },
      dependencies: {
        processRunner: editorProcess(target, "should-not-run"),
        async requestDecision() { assert.fail("No UI prompt"); },
        async requestFeedback() { assert.fail("No UI feedback"); },
      },
    });
    assert.equal(result.type, "blocked");
    assert.equal(await readFile(target, "utf8"), "intervening");
  });
});
