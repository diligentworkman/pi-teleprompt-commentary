import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import { postToolActionMessageTemplates } from "#/post-tool-actions/messages.ts";
import { reviewPolicyBlockMessageTemplates } from "#/review-policies/messages.ts";
import {
  reviewDecisionMessages,
  reviewFeedbackMessageTemplates,
} from "#/review-prompts/messages.ts";

type SelectionRequest = {
  title: string;
  options: Array<string>;
};

type InputRequest = {
  title: string;
  placeholder: string | undefined;
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-basic-review-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

function createBasicReviewHarness({
  cwd,
  hasUI = true,
  selection = "Accept",
  feedback,
  configurationSource = "",
  failingHook,
}: {
  cwd: string;
  hasUI?: boolean;
  selection?: string;
  feedback?: string;
  configurationSource?: string;
  failingHook?: string;
}) {
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const selectionRequests: Array<SelectionRequest> = [];
  const inputRequests: Array<InputRequest> = [];
  const processCommands: Array<Array<string>> = [];
  let currentSelection: string | undefined = selection;
  let currentFeedback = feedback;
  const context = {
    cwd,
    hasUI,
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    ui: {
      notify() {},
      async confirm() {
        throw new Error(
          "Basic review must not request workspace confirmation.",
        );
      },
      async select(title: string, options: Array<string>) {
        selectionRequests.push({ title, options });
        return currentSelection;
      },
      async input(title: string, placeholder?: string) {
        inputRequests.push({ title, placeholder });
        return currentFeedback;
      },
    },
  };
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: join(cwd, "config", "config.toml"),
      fileSystem: {
        async createDirectory() {
          throw new Error("Basic review must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Basic review must not create files.");
        },
        async readFile() {
          throw new Error("Basic review must not read files.");
        },
      },
      processRunner: {
        start({ command }) {
          processCommands.push(command);
          if (command[0] === failingHook) throw new Error("Hook startup failure");

          return {
            completion: Promise.resolve({
              type: "exited" as const,
              exitCode: 0,
              signal: null,
            }),
            async terminate() {
              return { type: "already-exited" as const };
            },
          };
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return configurationSource;
      },
      async readStarterConfigurationSource() {
        throw new Error("Basic review must not read starter configuration.");
      },
      async saveConfiguration() {
        throw new Error("Basic review must not save configuration.");
      },
    },
  });

  async function emit(name: string, event: unknown) {
    const handlers = eventHandlers.get(name);
    if (!handlers || handlers.length !== 1) {
      throw new Error(`The harness requires one ${name} handler.`);
    }

    return handlers[0](event, context);
  }

  return {
    selectionRequests,
    inputRequests,
    processCommands,
    async start() {
      await emit("session_start", { type: "session_start" });
    },
    toolCall(event: ToolCallEvent) {
      return emit("tool_call", event);
    },
    toolResult({
      toolCallId,
      content,
    }: {
      toolCallId: string;
      content: Array<{ type: "text"; text: string }>;
    }) {
      return emit("tool_result", {
        type: "tool_result",
        toolCallId,
        input: {},
        content,
        isError: false,
      });
    },
    toolExecutionEnd(toolCallId: string) {
      return emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId,
      });
    },
    shutdown() {
      return emit("session_shutdown", { type: "session_shutdown" });
    },
    setSelection(value: string | undefined) {
      currentSelection = value;
    },
    setFeedback(value: string | undefined) {
      currentFeedback = value;
    },
  };
}

function createWriteEvent({
  toolCallId,
  path,
}: {
  toolCallId: string;
  path: string;
}): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "write",
    input: { path, content: "proposed" },
  };
}

describe("basic review wiring", () => {
  describe("when a file tool uses the default prompt policy", () => {
    it("allows an accepted write after requesting a decision and optional feedback", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({ cwd });
      await harness.start();
      assert.equal(
        await harness.toolCall(
          createWriteEvent({
            toolCallId: "accepted-write",
            path: join(cwd, "accepted.txt"),
          }),
        ),
        undefined,
      );
      assert.deepEqual(harness.selectionRequests, [
        {
          title: reviewDecisionMessages.title,
          options: [...reviewDecisionMessages.options],
        },
      ]);
      assert.deepEqual(harness.inputRequests, [
        {
          title: reviewFeedbackMessageTemplates.title("accepted"),
          placeholder: reviewFeedbackMessageTemplates.placeholder(),
        },
      ]);
    });
    it("blocks without opening either prompt when interactive UI is unavailable", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({ cwd, hasUI: false });
      await harness.start();
      assert.deepEqual(
        await harness.toolCall(
          createWriteEvent({
            toolCallId: "unavailable-write",
            path: join(cwd, "unavailable.txt"),
          }),
        ),
        {
          block: true,
          reason: reviewPolicyBlockMessageTemplates.unavailable(),
        },
      );
      assert.deepEqual(harness.selectionRequests, []);
      assert.deepEqual(harness.inputRequests, []);
    });
  });
  describe("when review feedback accompanies the decision", () => {
    it("appends acceptance feedback once without replacing original tool-result content", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const feedback = "Please keep the generated header.";
      const toolCallId = "accepted-with-feedback";
      const harness = createBasicReviewHarness({ cwd, feedback });
      const originalContent = [{ type: "text" as const, text: "Written" }];
      await harness.start();
      await harness.toolCall(
        createWriteEvent({ toolCallId, path: join(cwd, "accepted.txt") }),
      );
      assert.deepEqual(
        await harness.toolResult({ toolCallId, content: originalContent }),
        {
          content: [
            ...originalContent,
            {
              type: "text",
              text: postToolActionMessageTemplates.userFeedback(feedback),
            },
          ],
        },
      );
      assert.equal(
        await harness.toolResult({ toolCallId, content: originalContent }),
        undefined,
      );
    });
    it("includes rejection feedback in the block reason and releases the reservation for a retry", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "rejected.txt");
      const feedback = "Use the existing formatter instead.";
      const harness = createBasicReviewHarness({
        cwd,
        selection: "Reject",
        feedback,
      });
      await harness.start();
      assert.deepEqual(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "rejected", path: targetPath }),
        ),
        {
          block: true,
          reason: reviewPolicyBlockMessageTemplates.rejected(feedback),
        },
      );
      harness.setSelection("Accept");
      harness.setFeedback(undefined);
      assert.equal(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "retry", path: targetPath }),
        ),
        undefined,
      );
    });
  });
  describe("when the accepted tool ends without a normal result", () => {
    it("clears feedback and releases the reservation at tool execution end", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "execution-ended.txt");
      const toolCallId = "execution-ended";
      const originalContent = [{ type: "text" as const, text: "Original" }];
      const harness = createBasicReviewHarness({
        cwd,
        feedback: "Pending feedback",
      });
      await harness.start();
      await harness.toolCall(
        createWriteEvent({ toolCallId, path: targetPath }),
      );
      await harness.toolExecutionEnd(toolCallId);
      assert.equal(
        await harness.toolResult({ toolCallId, content: originalContent }),
        undefined,
      );
      harness.setFeedback(undefined);
      assert.equal(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "retry", path: targetPath }),
        ),
        undefined,
      );
    });
    it("clears feedback and releases the reservation during session shutdown", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "shutdown.txt");
      const toolCallId = "shutdown-owner";
      const originalContent = [{ type: "text" as const, text: "Original" }];
      const harness = createBasicReviewHarness({
        cwd,
        feedback: "Pending feedback",
      });
      await harness.start();
      await harness.toolCall(
        createWriteEvent({ toolCallId, path: targetPath }),
      );
      await harness.shutdown();
      assert.equal(
        await harness.toolResult({ toolCallId, content: originalContent }),
        undefined,
      );
      harness.setFeedback(undefined);
      assert.deepEqual(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "retry", path: targetPath }),
        ),
        { block: true, reason: "The file review was blocked because review is shutting down." },
      );
    });
  });
  describe("when the tool does not require default file review", () => {
    it("preserves normal bash behavior without opening review prompts", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({ cwd });
      await harness.start();
      assert.equal(
        await harness.toolCall({
          type: "tool_call",
          toolCallId: "bash-call",
          toolName: "bash",
          input: { command: "printf hello" },
        }),
        undefined,
      );
      assert.deepEqual(harness.selectionRequests, []);
      assert.deepEqual(harness.inputRequests, []);
    });
  });
  describe("when a permission hook is configured for the prompt flow", () => {
    it("dispatches matching hooks in declaration order despite a startup failure and still prompts", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({
        cwd,
        failingHook: "first",
        configurationSource: `
[[hooks.tool_permission_request]]
action = ["first", { var = "tool_name" }]
[[hooks.tool_permission_request]]
"var:tool_name" = '^edit$'
action = ["skip"]
[[hooks.tool_permission_request]]
action = ["last", { var = "tool_name" }]
`,
      });
      await harness.start();
      assert.equal(await harness.toolCall(createWriteEvent({ toolCallId: "multiple-hooks", path: join(cwd, "new.txt") })), undefined);
      assert.deepEqual(harness.processCommands, [["first", "write"], ["last", "write"]]);
      assert.equal(harness.selectionRequests.length, 1);
    });

    for (const action of ["allow", "deny"] as const) {
      it(`suppresses permission hooks for explicit file ${action}`, async (testContext) => {
        const cwd = await createTemporaryDirectory(testContext);
        const harness = createBasicReviewHarness({
          cwd,
          configurationSource: `
[[handlers.new_file_editor]]
action = "${action}"
[[hooks.tool_permission_request]]
action = ["must-not-run"]
`,
        });
        await harness.start();
        const outcome = await harness.toolCall(createWriteEvent({ toolCallId: "explicit-policy", path: join(cwd, "new.txt") }));
        if (action === "allow") assert.equal(outcome, undefined);
        else assert.equal((outcome as { block: boolean }).block, true);
        assert.deepEqual(harness.processCommands, []);
        assert.deepEqual(harness.selectionRequests, []);
      });
    }
    it("dispatches the permission hook with the reviewed file tool name", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({
        cwd,
        configurationSource: [
          "[[hooks.tool_permission_request]]",
          'action = ["permission-hook", { var = "tool_name" }]',
        ].join("\n"),
      });
      await harness.start();
      await harness.toolCall(
        createWriteEvent({
          toolCallId: "hooked-write",
          path: join(cwd, "hooked.txt"),
        }),
      );
      assert.deepEqual(harness.processCommands, [["permission-hook", "write"]]);
      assert.equal(harness.selectionRequests.length, 1);
    });

    it("does not dispatch the permission hook when no interactive prompt can be displayed", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createBasicReviewHarness({
        cwd,
        hasUI: false,
        configurationSource: [
          "[[hooks.tool_permission_request]]",
          'action = ["permission-hook", { var = "tool_name" }]',
        ].join("\n"),
      });
      await harness.start();
      await harness.toolCall(
        createWriteEvent({
          toolCallId: "non-ui-write",
          path: join(cwd, "non-ui.txt"),
        }),
      );
      assert.deepEqual(harness.processCommands, []);
      assert.deepEqual(harness.selectionRequests, []);
    });
  });
});
