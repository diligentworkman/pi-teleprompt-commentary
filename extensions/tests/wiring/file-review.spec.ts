import { createEditToolDefinition, createWriteToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import type { PiFilePreviewInput } from "#/file-preview/types.ts";
import type { ProcessRunner } from "#/process/index.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-file-wiring-")));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

const editorRules = `
[[handlers.diff_editor]]
action = ["editor", { var = "new_content_file_path" }, { var = "old_content_file_path" }]
[[handlers.new_file_editor]]
action = ["editor", { var = "new_file_path" }]
`;

function harness(root: string, edit: (target: string, original?: string) => Promise<void>, configuration: string | (() => Promise<string>) = editorRules, runner?: ProcessRunner) {
  const handlers = new Map<string, (event: any, context: any) => unknown>();
  const commands: Array<Array<string>> = [];
  const processRunner: ProcessRunner = {
    start({ command }) {
      commands.push(command);
      return {
        completion: edit(command[1]!, command[2]).then(() => ({ type: "exited" as const, exitCode: 0, signal: null })),
        async terminate() { return { type: "already-exited" }; },
      };
    },
    async cleanup() { return []; },
  };
  const context = {
    cwd: root, hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: { notify() {}, async select() { assert.fail("No UI prompt"); }, async input() { assert.fail("No UI feedback"); } },
  };
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: join(root, "config.toml"),
      fileSystem: {
        async createDirectory() { assert.fail("Unexpected configuration write"); },
        async createFileExclusively() { assert.fail("Unexpected configuration write"); },
        async readFile() { assert.fail("Unexpected configuration read"); },
      },
      processRunner: runner ?? processRunner,
      temporaryFileStore: createRuntimeTemporaryFileStore({ temporaryRootPath: root, createFileId: randomUUID }),
      async readConfigurationFile() { return typeof configuration === "string" ? configuration : configuration(); },
      async readStarterConfigurationSource() { assert.fail("Unexpected starter read"); },
      async saveConfiguration() { assert.fail("Unexpected configuration save"); },
    },
  });
  async function emit(name: string, event: any): Promise<any> {
    return handlers.get(name)!(event, context);
  }
  return {
    commands,
    emit,
    async call(id: string, preview: PiFilePreviewInput) {
      return emit("tool_call", { type: "tool_call", toolCallId: id, ...preview });
    },
    async execute(id: string, preview: PiFilePreviewInput) {
      const toolContext = context as unknown as ExtensionToolContext;
      if (preview.toolName === "write") {
        return createWriteToolDefinition(root).execute(id, preview.input, undefined, undefined, toolContext);
      }
      return createEditToolDefinition(root).execute(id, preview.input, undefined, undefined, toolContext);
    },
    async result(id: string, content: unknown, isError = false) {
      return emit("tool_result", { type: "tool_result", toolCallId: id, content, isError });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("external file review wiring", () => {
  it("cleans prepared artifacts without launching an editor when shutdown interrupts policy loading", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const loading = deferred<void>();
    const releaseConfiguration = deferred<string>();
    const runtime = harness(root, async () => {
      assert.fail("Cancelled preparation must not launch an editor");
    }, async () => {
      loading.resolve();
      return releaseConfiguration.promise;
    });
    const review = runtime.call("preparing", {
      toolName: "write", input: { path: target, content: "proposal" },
    });
    await loading.promise;
    const shutdown = runtime.emit("session_shutdown", {});
    releaseConfiguration.resolve(editorRules);
    await shutdown;
    const blocked = await review;
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /shutting down/);
    assert.deepEqual(runtime.commands, []);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await readdir(root), ["existing.txt"]);
    assert.equal(await runtime.result("preparing", []), undefined);
  });
  it("blocks new file calls after shutdown without previewing or creating runtime artifacts", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const runtime = harness(root, async () => {
      assert.fail("Shutdown must not launch an editor");
    });
    await runtime.emit("session_shutdown", {});
    const blocked = await runtime.call("after-shutdown", {
      toolName: "write", input: { path: target, content: "proposal" },
    });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /shutting down/);
    assert.deepEqual(runtime.commands, []);
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual(await readdir(root), ["existing.txt"]);
  });
  it("blocks same-path calls during review and execution while allowing an unrelated review", async (testContext) => {
    const root = await fixture(testContext);
    const firstPath = join(root, "first.txt");
    const unrelatedPath = join(root, "unrelated.txt");
    await writeFile(firstPath, "first original");
    await writeFile(unrelatedPath, "unrelated original");
    const started = deferred<void>();
    const finishEditor = deferred<void>();
    const runtime = harness(root, async (target) => {
      if (target === firstPath) {
        started.resolve();
        await finishEditor.promise;
      }
      await writeFile(target, "reviewed");
    });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const first: PiFilePreviewInput = { toolName: "write", input: { path: firstPath, content: "proposal" } };
    const samePathEdit: PiFilePreviewInput = {
      toolName: "edit", input: { path: firstPath, edits: [{ oldText: "proposal", newText: "conflict" }] },
    };
    const unrelated: PiFilePreviewInput = {
      toolName: "write", input: { path: unrelatedPath, content: "unrelated proposal" },
    };
    const firstReview = runtime.call("first", first);
    await started.promise;
    assert.equal((await runtime.call("conflicting-review", samePathEdit)).block, true);
    assert.equal(runtime.commands.length, 1);
    assert.equal(await readFile(firstPath, "utf8"), "proposal");
    assert.equal(await runtime.call("unrelated", unrelated), undefined);
    assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated original");
    const nativeUnrelated = await runtime.execute("unrelated", unrelated);
    await runtime.result("unrelated", nativeUnrelated.content);
    assert.equal(await readFile(unrelatedPath, "utf8"), "reviewed");
    assert.equal(await readFile(firstPath, "utf8"), "proposal");
    finishEditor.resolve();
    assert.equal(await firstReview, undefined);
    assert.equal(await readFile(firstPath, "utf8"), "first original");
    assert.equal((await runtime.call("conflicting-execution", first)).block, true);
    const nativeFirst = await runtime.execute("first", first);
    await runtime.result("first", nativeFirst.content);
    assert.equal(await readFile(firstPath, "utf8"), "reviewed");
    assert.equal(await runtime.call("retry", first), undefined);
    await runtime.emit("tool_execution_end", { toolCallId: "retry" });
  });
  it("allows unchanged editor content without registering a content override", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const runtime = harness(root, async (path) => {
      assert.equal(await readFile(path, "utf8"), "proposal");
    });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = { toolName: "write", input: { path: target, content: "proposal" } };
    assert.equal(await runtime.call("unchanged", preview), undefined);
    assert.equal(await readFile(target, "utf8"), "original");
    const native = await runtime.execute("unchanged", preview);
    assert.equal(await runtime.result("unchanged", native.content), undefined);
    assert.equal(await readFile(target, "utf8"), "proposal");
    assert.equal(await runtime.call("retry", preview), undefined);
    await runtime.emit("tool_execution_end", { toolCallId: "retry" });
  });

  it("restores and releases the target after editor failure without registering an override", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    let artifactPath = "";
    let attempts = 0;
    const runtime = harness(root, async (path, original) => {
      artifactPath = original!;
      attempts++;
      if (attempts === 1) {
        await writeFile(path, "partial editor change");
        throw new Error("editor failed");
      }
    });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = { toolName: "write", input: { path: target, content: "proposal" } };
    const blocked = await runtime.call("editor-failure", preview);
    assert.equal(blocked.block, true);
    assert.equal(await readFile(target, "utf8"), "original");
    await assert.rejects(stat(artifactPath), { code: "ENOENT" });
    assert.equal(await runtime.result("editor-failure", []), undefined);
    assert.equal(await runtime.call("retry", preview), undefined);
    assert.equal(attempts, 2);
    await runtime.emit("tool_execution_end", { toolCallId: "retry" });
  });

  it("annotates post-apply failure, consumes the action, and releases the reservation", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "nested", "new.txt");
    const runtime = harness(root, async (path) => { await writeFile(path, "private reviewed content"); });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = { toolName: "write", input: { path: target, content: "proposal" } };
    assert.equal(await runtime.call("apply-failure", preview), undefined);
    // Preview removed the initially missing parent; failed normal execution left it absent.
    const nativeError = [{ type: "text", text: "Original tool failure" }];
    const annotated = await runtime.result("apply-failure", nativeError, true);
    assert.deepEqual(annotated.content[0], nativeError[0]);
    assert.match(annotated.content[1].text, /could not be applied/);
    assert.equal(annotated.isError, undefined);
    assert.equal(JSON.stringify(annotated).includes("private reviewed content"), false);
    assert.equal(await runtime.result("apply-failure", nativeError, true), undefined);
    assert.equal(await runtime.call("retry", preview), undefined);
    await runtime.emit("tool_execution_end", { toolCallId: "retry" });
  });
  for (const existing of [true, false]) {
    it(`cancels active ${existing ? "existing" : "new"}-file review and restores before shutdown returns`, async (testContext) => {
      const root = await fixture(testContext);
      const target = join(root, "file.txt");
      if (existing) await writeFile(target, "original");
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let terminationCount = 0;
      let artifactPath: string | undefined;
      const runtime = harness(root, async () => {}, editorRules, {
        start({ command }) {
          artifactPath = command[2];
          markStarted();
          return {
            completion: new Promise(() => {}),
            async terminate() {
              terminationCount++;
              assert.equal(await readFile(target, "utf8"), "proposal");
              return { type: "termination-observed" };
            },
          };
        },
        async cleanup() { return []; },
      });
      const preview: PiFilePreviewInput = { toolName: "write", input: { path: target, content: "proposal" } };
      const review = runtime.call("shutdown-review", preview);
      await started;
      await runtime.emit("session_shutdown", {});
      const blocked = await review;
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /shutting down/);
      assert.equal(terminationCount, 1);
      if (existing) assert.equal(await readFile(target, "utf8"), "original");
      else await assert.rejects(stat(target), { code: "ENOENT" });
      if (artifactPath !== undefined) await assert.rejects(stat(artifactPath), { code: "ENOENT" });
      assert.equal(await runtime.result("shutdown-review", []), undefined);
    });
  }
  for (const toolName of ["write", "edit"] as const) {
    it(`restores the existing target before normal ${toolName}, then applies reviewed bytes exactly once`, async (testContext) => {
      const root = await fixture(testContext);
      const target = join(root, "existing.txt");
      await writeFile(target, "original");
      let originalArtifact = "";
      const runtime = harness(root, async (path, original) => {
        assert.equal(await readFile(path, "utf8"), "proposal");
        assert.ok(original);
        originalArtifact = original;
        assert.equal(await readFile(original, "utf8"), "original");
        await writeFile(path, "reviewed");
      });
      testContext.after(() => runtime.emit("session_shutdown", {}));
      const preview: PiFilePreviewInput = toolName === "write"
        ? { toolName, input: { path: target, content: "proposal" } }
        : { toolName, input: { path: target, edits: [{ oldText: "original", newText: "proposal" }] } };
      assert.equal(await runtime.call("review", preview), undefined);
      assert.equal(await readFile(target, "utf8"), "original");
      await assert.rejects(stat(originalArtifact), { code: "ENOENT" });
      const nativeResult = await runtime.execute("review", preview);
      assert.equal(await readFile(target, "utf8"), "proposal");
      const annotated = await runtime.result("review", nativeResult.content);
      assert.equal(await readFile(target, "utf8"), "reviewed");
      assert.deepEqual(annotated.content.slice(0, nativeResult.content.length), nativeResult.content);
      assert.equal(annotated.isError, undefined);
      assert.equal(JSON.stringify(annotated).includes("reviewed bytes"), false);
      await writeFile(target, "later change");
      assert.equal(await runtime.result("review", nativeResult.content), undefined);
      assert.equal(await readFile(target, "utf8"), "later change");
    });
  }

  it("cleans a nested new-file preview and applies an empty reviewed file after normal write", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "nested", "new.txt");
    const runtime = harness(root, async (path, original) => {
      assert.equal(original, undefined);
      assert.equal(await readFile(path, "utf8"), "proposal");
      await writeFile(path, "");
    });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = { toolName: "write", input: { path: target, content: "proposal" } };
    assert.equal(await runtime.call("new", preview), undefined);
    await assert.rejects(stat(join(root, "nested")), { code: "ENOENT" });
    const nativeResult = await runtime.execute("new", preview);
    await runtime.result("new", nativeResult.content);
    assert.equal(await readFile(target, "utf8"), "");
  });

  it("does not launch an editor after native preview failure and lets normal Pi report the native error", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const runtime = harness(root, async () => { assert.fail("No misleading editor preview"); });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = {
      toolName: "edit", input: { path: target, edits: [{ oldText: "absent", newText: "proposal" }] },
    };
    assert.equal(await runtime.call("native-failure", preview), undefined);
    await assert.rejects(runtime.execute("native-failure", preview), /Could not find the exact text/);
    assert.equal(await runtime.result("native-failure", [{ type: "text", text: "native failure" }], true), undefined);
    assert.deepEqual(runtime.commands, []);
    assert.equal(await readFile(target, "utf8"), "original");
  });

  it("applies reviewed content even if the normal edit fails without overriding isError", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "existing.txt");
    await writeFile(target, "original");
    const runtime = harness(root, async (path) => { await writeFile(path, "reviewed"); });
    testContext.after(() => runtime.emit("session_shutdown", {}));
    const preview: PiFilePreviewInput = {
      toolName: "edit", input: { path: target, edits: [{ oldText: "original", newText: "proposal" }] },
    };
    assert.equal(await runtime.call("failed-normal", preview), undefined);
    await writeFile(target, "intervening content");
    await assert.rejects(runtime.execute("failed-normal", preview), /Could not find the exact text/);
    const originalContent = [{ type: "text", text: "native failure" }];
    const annotated = await runtime.result("failed-normal", originalContent, true);
    assert.equal(annotated.isError, undefined);
    assert.deepEqual(annotated.content[0], originalContent[0]);
    assert.equal(await readFile(target, "utf8"), "reviewed");
  });
});
