import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

async function createTemporaryRoot(testContext: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teleprompt-bash-wiring-"));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function createBashWiringHarness({
  root,
  configuration,
  hasUI = false,
  selection = "Accept",
  feedback,
  editCommand,
  completion = { type: "exited", exitCode: 0, signal: null },
  startupError,
  pendingEditor = false,
}: {
  root: string;
  configuration: string;
  hasUI?: boolean;
  selection?: string;
  feedback?: string;
  editCommand?: (path: string) => Promise<void>;
  completion?: ProcessCompletion;
  startupError?: unknown;
  pendingEditor?: boolean;
}) {
  const handlers = new Map<string, (event: any, context: any) => unknown>();
  const commands: Array<[string, ...Array<string>]> = [];
  const commandFiles: Array<string> = [];
  const prompts: Array<string> = [];
  const toolEvents: Array<{ input: { command: string } }> = [];
  let cleanupCount = 0;
  let resolveTermination: (() => void) | undefined;
  let markEditorStarted: (() => void) | undefined;
  const editorStarted = new Promise<void>((resolve) => {
    markEditorStarted = resolve;
  });
  const processRunner: ProcessRunner = {
    start({ command }) {
      commands.push(command);
      if (command[0] === "editor") {
        if (startupError !== undefined) throw startupError;
        const path = command[1];
        if (path === undefined) throw new Error("Editor path is required.");
        commandFiles.push(path);
        markEditorStarted?.();
        return {
          completion: pendingEditor
            ? new Promise<ProcessCompletion>(() => {})
            : (async () => {
            await editCommand?.(path);
            return completion;
          })(),
          async terminate() {
            if (pendingEditor) {
              await new Promise<void>((resolve) => {
                if (cleanupCount > 0) {
                  resolve();
                } else {
                  resolveTermination = resolve;
                }
              });
              return { type: "termination-observed" };
            }
            return { type: "already-exited" };
          },
        };
      }
      return {
        completion: Promise.resolve({ type: "exited", exitCode: 0, signal: null }),
        async terminate() {
          return { type: "already-exited" };
        },
      };
    },
    async cleanup() {
      cleanupCount += 1;
      resolveTermination?.();
      return [];
    },
  };
  const context = {
    cwd: root,
    hasUI,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify() {},
      async select(title: string) {
        prompts.push(title);
        return selection;
      },
      async input() {
        return feedback;
      },
    },
  };
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: join(root, "config.toml"),
      fileSystem: {
        async createDirectory() { throw new Error("Unexpected config write"); },
        async createFileExclusively() { throw new Error("Unexpected config write"); },
        async readFile() { throw new Error("Unexpected config read"); },
      },
      processRunner,
      temporaryFileStore: createRuntimeTemporaryFileStore({
        temporaryRootPath: root,
        createFileId: () => crypto.randomUUID(),
      }),
      readConfigurationFile: async () => configuration,
      async readStarterConfigurationSource() { throw new Error("Unexpected starter read"); },
      async saveConfiguration() { throw new Error("Unexpected config save"); },
    },
  });
  function emit(name: string, event: unknown) {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`Missing ${name} handler`);
    return handler(event, context);
  }
  return {
    commands,
    commandFiles,
    prompts,
    toolEvents,
    editorStarted,
    getCleanupCount: () => cleanupCount,
    start: () => emit("session_start", { type: "session_start" }),
    toolCall(toolCallId: string, command: string) {
      const event = {
        type: "tool_call", toolName: "bash", toolCallId, input: { command },
      } satisfies ToolCallEvent;
      toolEvents.push(event);
      return emit("tool_call", event);
    },
    toolResult(toolCallId: string) {
      return emit("tool_result", {
        type: "tool_result", toolCallId, input: {}, isError: false,
        content: [{ type: "text", text: "original output" }],
      });
    },
    shutdown: () => emit("session_shutdown", { type: "session_shutdown" }),
  };
}

const editorRule = [
  "[[handlers.command_editor]]",
  '"var:command_string" = "^printf"',
  'action = ["editor", { var = "command_file_path" }]',
].join("\n");

describe("Bash review extension wiring", () => {
  describe("when the raw command matches an editor action", () => {
    it("accepts unchanged content and cleans the command file before the tool executes", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({ root, configuration: editorRule });
      await harness.start();
      assert.equal(await harness.toolCall("unchanged", "printf hello"), undefined);
      assert.equal(harness.commandFiles.length, 1);
      assert.equal(dirname(dirname(harness.commandFiles[0]!)), root);
      assert.deepEqual(await readdir(dirname(harness.commandFiles[0]!)), []);
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0]]]);
      assert.deepEqual(harness.prompts, []);
    });

    it("replaces the tool input with the complete edited command and annotates its result", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const suggestion = `printf '${"x".repeat(10_000)}'`;
      const harness = createBashWiringHarness({
        root, configuration: editorRule,
        async editCommand(path) {
          assert.equal(await readFile(path, "utf8"), "printf hello");
          await writeFile(path, suggestion);
        },
      });
      await harness.start();
      assert.equal(await harness.toolCall("changed", "printf hello"), undefined);
      assert.equal(harness.toolEvents[0]?.input.command, suggestion);
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0]]]);
      assert.deepEqual(await readdir(dirname(harness.commandFiles[0]!)), []);
      const result = await harness.toolResult("changed") as { content: Array<{ type: "text"; text: string }> };
      assert.equal(result.content[0]?.text, "original output");
      assert.equal(result.content.at(-1)?.text.endsWith(suggestion), true);
      assert.equal(await harness.toolResult("changed"), undefined);
    });

    it("blocks an empty edited command without executing a replacement", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, configuration: editorRule,
        editCommand: (path) => writeFile(path, ""),
      });
      await harness.start();
      const result = await harness.toolCall("empty", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /editor saved an empty command/);
      assert.equal(harness.toolEvents[0]?.input.command, "printf hello");
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0]]]);
      assert.deepEqual(await readdir(dirname(harness.commandFiles[0]!)), []);
    });

    it("matches the raw command rather than an escaped or normalized version", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const raw = "printf 'two  spaces'\n";
      const harness = createBashWiringHarness({
        root,
        configuration: [
          "[[handlers.command_editor]]",
          "'var:command_string' = 'two  spaces'",
          'action = ["editor", { var = "command_file_path" }, { var = "command_string" }]',
        ].join("\n"),
        async editCommand(path) {
          assert.equal(await readFile(path, "utf8"), raw);
        },
      });
      await harness.start();
      assert.equal(await harness.toolCall("raw", raw), undefined);
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0], raw]]);
    });

    it("dispatches the permission hook when the editor races with a real UI prompt", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, hasUI: true, selection: "Reject", feedback: "Do not run this.",
        configuration: [editorRule, "[[hooks.tool_permission_request]]", 'action = ["hook", { var = "tool_name" }]'].join("\n"),
      });
      await harness.start();
      const result = await harness.toolCall("ui-editor", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /Do not run this\./);
      assert.equal(harness.prompts.length, 1);
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0]], ["hook", "bash"]]);
      assert.deepEqual(await readdir(dirname(harness.commandFiles[0]!)), []);
    });

    it("blocks a synchronous editor startup failure and removes its command file", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, configuration: editorRule,
        startupError: new Error("editor failed to start"),
      });
      await harness.start();
      const result = await harness.toolCall("startup", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /without a decision/);
      assert.equal(harness.commands.length, 1);
      assert.equal(harness.commands[0]?.[0], "editor");
      const commandPath = harness.commands[0]?.[1];
      assert.equal(typeof commandPath, "string");
      assert.deepEqual(harness.commandFiles, []);
      assert.deepEqual(await readdir(dirname(commandPath!)), []);
    });

    it("blocks non-UI editor failure without dispatching a permission hook", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root,
        configuration: [editorRule, "[[hooks.tool_permission_request]]", 'action = ["hook", { var = "tool_name" }]'].join("\n"),
        completion: { type: "exited", exitCode: 1, signal: null },
      });
      await harness.start();
      const result = await harness.toolCall("failed", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /without a decision/);
      assert.deepEqual(harness.commands, [["editor", harness.commandFiles[0]]]);
      assert.deepEqual(await readdir(dirname(harness.commandFiles[0]!)), []);
    });
  });

  describe("when configuration chooses a prompt or no action", () => {
    it("preserves normal behavior for an unmatched raw command", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({ root, configuration: editorRule });
      await harness.start();
      assert.equal(await harness.toolCall("unmatched", "echo hello"), undefined);
      assert.deepEqual(harness.commands, []);
      assert.deepEqual(harness.prompts, []);
    });

    it("honors explicit allow and deny without a permission hook or prompt", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      for (const action of ["allow", "deny"]) {
        const harness = createBashWiringHarness({
          root, hasUI: true,
          configuration: [
            "[[handlers.command_editor]]", `action = "${action}"`,
            "[[hooks.tool_permission_request]]", 'action = ["hook", { var = "tool_name" }]',
          ].join("\n"),
        });
        await harness.start();
        const result = await harness.toolCall(action, "printf hello");
        if (action === "allow") {
          assert.equal(result, undefined);
        } else {
          assert.deepEqual(result, { block: true, reason: "Tool call denied by review policy." });
        }
        assert.deepEqual(harness.commands, []);
        assert.deepEqual(harness.prompts, []);
      }
    });

    it("blocks a prompt without UI without dispatching the permission hook", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root,
        configuration: [
          "[[handlers.command_editor]]", 'action = "prompt"',
          "[[hooks.tool_permission_request]]", 'action = ["hook", { var = "tool_name" }]',
        ].join("\n"),
      });
      await harness.start();
      const result = await harness.toolCall("non-ui-prompt", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /interactive review is unavailable/);
      assert.deepEqual(harness.commands, []);
      assert.deepEqual(harness.prompts, []);
    });

    it("blocks a rejected prompt with feedback and never attaches a post-tool action", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, hasUI: true, selection: "Reject", feedback: "Try a different command.",
        configuration: ["[[handlers.command_editor]]", 'action = "prompt"'].join("\n"),
      });
      await harness.start();
      const result = await harness.toolCall("rejected", "printf hello") as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /Try a different command\./);
      assert.equal(harness.prompts.length, 1);
      assert.deepEqual(harness.commands, []);
      assert.equal(await harness.toolResult("rejected"), undefined);
    });

    it("delivers accepted prompt feedback exactly once through the tool result", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, hasUI: true, selection: "Accept", feedback: "Reviewed as written.",
        configuration: [
          "[[handlers.command_editor]]", '"var:command_string" = "^printf"', 'action = "prompt"',
          "[[hooks.tool_permission_request]]", 'action = ["hook", { var = "tool_name" }]',
        ].join("\n"),
      });
      await harness.start();
      assert.equal(await harness.toolCall("accepted", "printf hello"), undefined);
      assert.deepEqual(harness.commands, [["hook", "bash"]]);
      assert.equal(harness.prompts.length, 1);
      const result = await harness.toolResult("accepted") as { content: Array<{ type: "text"; text: string }> };
      assert.equal(result.content[0]?.text, "original output");
      assert.match(result.content.at(-1)?.text ?? "", /Reviewed as written\./);
      assert.equal(await harness.toolResult("accepted"), undefined);
    });

    it("cancels an active editor review and blocks the command before removing its temporary root on shutdown", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({
        root, configuration: editorRule, pendingEditor: true,
      });
      await harness.start();
      const toolCall = harness.toolCall("pending", "printf hello");
      await harness.editorStarted;
      const commandPath = harness.commandFiles[0]!;
      assert.equal(await readFile(commandPath, "utf8"), "printf hello");
      await harness.shutdown();
      const result = await toolCall as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /shutting down/);
      assert.equal(harness.getCleanupCount(), 1);
      assert.deepEqual(await readdir(root), []);
      assert.deepEqual(await harness.toolCall("late", "printf hello"), {
        block: true,
        reason: "The command was blocked because review is shutting down.",
      });
    });

    it("cleans tracked processes before removing the runtime directory on shutdown", async (testContext) => {
      const root = await createTemporaryRoot(testContext);
      const harness = createBashWiringHarness({ root, configuration: editorRule });
      await harness.start();
      await harness.toolCall("shutdown", "printf hello");
      const runtimeDirectory = dirname(harness.commandFiles[0]!);
      await harness.shutdown();
      assert.equal(harness.getCleanupCount(), 1);
      assert.deepEqual(await readdir(root), []);
      assert.equal(await readdir(runtimeDirectory).then(() => true, () => false), false);
    });
  });
});
