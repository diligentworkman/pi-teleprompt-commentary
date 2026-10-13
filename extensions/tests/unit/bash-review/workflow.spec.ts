import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewBashCommand } from "#/bash-review/index.ts";
import type { ResolvedAction } from "#/config-loader/index.ts";
import type {
  ProcessCompletion,
  ProcessRunner,
  TerminationOutcome,
} from "#/process/index.ts";
import type {
  ReviewDecisionInput,
  ReviewDecisionOutcome,
} from "#/review-prompts/index.ts";
import type { RuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

const rawCommand = "printf '%s\\n' 'raw command'";
const commandFilePath = "/runtime/command-review.txt";
const editorCommand: [string, ...Array<string>] = [
  "editor",
  "--wait",
  commandFilePath,
];

type HarnessOptions = {
  configuredAction?: ResolvedAction;
  completion?: ProcessCompletion;
  editedCommand?: string;
  decision?: ReviewDecisionOutcome;
  feedback?: string;
  createError?: unknown;
  cleanupError?: unknown;
  resolutionError?: unknown;
  startError?: unknown;
  termination?: TerminationOutcome;
};

function waitForAbort(input: ReviewDecisionInput): Promise<ReviewDecisionOutcome> {
  if (!input.hasUI) {
    return Promise.resolve({ type: "unavailable" });
  }
  if (input.signal?.aborted) {
    return Promise.resolve({ type: "superseded" });
  }

  return new Promise((resolve) => {
    input.signal?.addEventListener(
      "abort",
      () => resolve({ type: "superseded" }),
      { once: true },
    );
  });
}

function createWorkflowHarness(options: HarnessOptions = {}) {
  const createdContents: Array<string | Uint8Array> = [];
  const resolvedVariables: Array<{
    commandFilePath: string;
    commandString: string;
  }> = [];
  const startedCommands: Array<[string, ...Array<string>]> = [];
  const decisionInputs: Array<ReviewDecisionInput> = [];
  const feedbackDecisions: Array<"accepted" | "rejected"> = [];
  let cleanupCount = 0;
  let readCount = 0;
  let terminationCount = 0;
  const temporaryFileStore: RuntimeTemporaryFileStore = {
    async createFile({ content }) {
      if (options.createError !== undefined) {
        throw options.createError;
      }
      createdContents.push(content);

      return {
        path: commandFilePath,
        async cleanup() {
          cleanupCount += 1;
          if (options.cleanupError !== undefined) {
            throw options.cleanupError;
          }
        },
      };
    },
    async cleanup() {},
  };
  const processRunner: ProcessRunner = {
    start({ command }) {
      if (options.startError !== undefined) {
        throw options.startError;
      }
      startedCommands.push(command);

      return {
        completion: Promise.resolve(
          options.completion ?? {
            type: "exited",
            exitCode: 0,
            signal: null,
          },
        ),
        async terminate() {
          terminationCount += 1;

          return options.termination ?? { type: "already-exited" };
        },
      };
    },
    async cleanup() {
      return [];
    },
  };

  return {
    dependencies: {
      temporaryFileStore,
      processRunner,
      async resolveConfiguredAction(variables: {
        commandFilePath: string;
        commandString: string;
      }) {
        resolvedVariables.push(variables);
        if (options.resolutionError !== undefined) {
          throw options.resolutionError;
        }

        return options.configuredAction;
      },
      async readCommandFile(path: string) {
        readCount += 1;
        if (path !== commandFilePath) {
          throw new Error(`Unexpected command file path: ${path}`);
        }

        return options.editedCommand ?? rawCommand;
      },
      requestDecision(input: ReviewDecisionInput) {
        decisionInputs.push(input);

        return options.decision === undefined
          ? waitForAbort(input)
          : Promise.resolve(options.decision);
      },
      async requestFeedback({ decision }: { decision: "accepted" | "rejected" }) {
        feedbackDecisions.push(decision);

        return options.feedback;
      },
    },
    createdContents,
    resolvedVariables,
    startedCommands,
    decisionInputs,
    feedbackDecisions,
    getCleanupCount: () => cleanupCount,
    getReadCount: () => readCount,
    getTerminationCount: () => terminationCount,
  };
}

async function runReview({
  harness,
  hasUI = true,
  signal,
}: {
  harness: ReturnType<typeof createWorkflowHarness>;
  hasUI?: boolean;
  signal?: AbortSignal;
}) {
  return reviewBashCommand({
    input: { command: rawCommand, hasUI, signal },
    dependencies: harness.dependencies,
  });
}

describe("Bash command review workflow", () => {
  describe("when configuration selects a non-external policy", () => {
    it("defaults an unmatched raw command to allow and cleans its resolution file", async () => {
      const harness = createWorkflowHarness();

      assert.deepEqual(await runReview({ harness }), { type: "allowed" });
      assert.deepEqual(harness.createdContents, [rawCommand]);
      assert.deepEqual(harness.resolvedVariables, [
        { commandFilePath, commandString: rawCommand },
      ]);
      assert.deepEqual(harness.startedCommands, []);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("blocks an explicitly denied command without starting an editor", async () => {
      const harness = createWorkflowHarness({ configuredAction: "deny" });

      const outcome = await runReview({ harness });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /denied by review policy/);
      assert.deepEqual(harness.startedCommands, []);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("allows prompt acceptance and preserves exact acceptance feedback", async () => {
      const harness = createWorkflowHarness({
        configuredAction: "prompt",
        decision: { type: "accepted" },
        feedback: "Proceed after checking production.",
      });

      assert.deepEqual(await runReview({ harness }), {
        type: "allowed",
        feedback: "Proceed after checking production.",
      });
      assert.deepEqual(harness.feedbackDecisions, ["accepted"]);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("blocks prompt rejection and includes exact rejection feedback", async () => {
      const harness = createWorkflowHarness({
        configuredAction: "prompt",
        decision: { type: "rejected" },
        feedback: "Use the read-only command instead.",
      });

      const outcome = await runReview({ harness });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /Use the read-only command instead\./);
      assert.deepEqual(harness.feedbackDecisions, ["rejected"]);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("fails a prompt policy closed when interactive UI is unavailable", async () => {
      const harness = createWorkflowHarness({ configuredAction: "prompt" });

      const outcome = await runReview({ harness, hasUI: false });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /interactive review is unavailable/);
      assert.deepEqual(harness.decisionInputs, [
        { hasUI: false, signal: undefined },
      ]);
      assert.equal(harness.getCleanupCount(), 1);
    });
  });

  describe("when configuration selects an external editor", () => {
    it("allows the original command after an unchanged non-UI editor result", async () => {
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
      });

      assert.deepEqual(await runReview({ harness, hasUI: false }), {
        type: "allowed",
      });
      assert.deepEqual(harness.startedCommands, [editorCommand]);
      assert.equal(harness.getReadCount(), 1);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("returns the complete non-empty edited command for Pi to execute", async () => {
      const editedCommand = `printf '%s' '${"x".repeat(10_000)}'`;
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        editedCommand,
      });

      const outcome = await runReview({ harness, hasUI: false });
      assert.deepEqual(outcome, { type: "edited", command: editedCommand });
      assert.deepEqual(harness.startedCommands, [editorCommand]);
      assert.equal(harness.startedCommands.flat().includes(editedCommand), false);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("blocks an empty edited command rather than authorizing it", async () => {
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        editedCommand: "",
      });

      const outcome = await runReview({ harness, hasUI: false });
      assert.deepEqual(outcome, {
        type: "blocked",
        reason: "The command was blocked because the editor saved an empty command.",
      });
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("allows prompt acceptance, preserves feedback, and cancels the editor once", async () => {
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        decision: { type: "accepted" },
        feedback: "Original command is acceptable.",
        termination: { type: "termination-observed" },
      });

      assert.deepEqual(await runReview({ harness }), {
        type: "allowed",
        feedback: "Original command is acceptable.",
      });
      assert.equal(harness.getTerminationCount(), 1);
      assert.equal(harness.getCleanupCount(), 1);
    });

    for (const termination of [
      { type: "termination-unconfirmed" },
      { type: "termination-failed", error: new Error("editor could not be terminated") },
    ] satisfies Array<TerminationOutcome>) {
      it(`blocks prompt acceptance when editor cancellation returns ${termination.type} and cleans its artifact once`, async () => {
        const harness = createWorkflowHarness({
          configuredAction: editorCommand,
          decision: { type: "accepted" },
          feedback: "Original command is acceptable.",
          termination,
        });
        assert.deepEqual(await runReview({ harness }), {
          type: "blocked",
          reason: "The command was blocked because the editor's termination could not be confirmed; close the editor before retrying.",
        });
        assert.deepEqual(harness.startedCommands, [editorCommand]);
        assert.deepEqual(harness.feedbackDecisions, ["accepted"]);
        assert.equal(harness.getTerminationCount(), 1);
        assert.equal(harness.getCleanupCount(), 1);
      });
    }
    it("keeps the UI prompt viable after editor failure", async () => {
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: 7,
        signal: null,
      };
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        completion,
        decision: { type: "accepted" },
      });

      assert.deepEqual(await runReview({ harness }), { type: "allowed" });
      assert.equal(harness.decisionInputs.length, 1);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("blocks editor failure when no interactive UI is available", async () => {
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        completion: { type: "exited", exitCode: 9, signal: null },
      });

      const outcome = await runReview({ harness, hasUI: false });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /external review ended without a decision/);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("blocks and cleans up when an already-cancelled caller never starts the editor", async () => {
      const controller = new AbortController();
      controller.abort();
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
      });

      const outcome = await runReview({
        harness,
        hasUI: false,
        signal: controller.signal,
      });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /review was cancelled/);
      assert.deepEqual(harness.startedCommands, []);
      assert.equal(harness.getCleanupCount(), 1);
    });
  });

  describe("when workflow infrastructure fails", () => {
    it("fails closed when command-file creation throws", async () => {
      const createError = new Error("temporary storage unavailable");
      const harness = createWorkflowHarness({ createError });

      const outcome = await runReview({ harness });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /temporary storage unavailable/);
      assert.deepEqual(harness.resolvedVariables, []);
      assert.equal(harness.getCleanupCount(), 0);
    });

    it("fails closed and cleans the command file when rule resolution throws", async () => {
      const harness = createWorkflowHarness({
        resolutionError: new Error("configuration resolution failed"),
      });

      const outcome = await runReview({ harness });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /configuration resolution failed/);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("fails closed after a synchronous editor startup failure", async () => {
      const harness = createWorkflowHarness({
        configuredAction: editorCommand,
        startError: new Error("spawn threw synchronously"),
      });

      const outcome = await runReview({ harness, hasUI: false });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /external review ended without a decision/);
      assert.equal(harness.getCleanupCount(), 1);
    });

    it("lets cleanup failure override an otherwise allowed result", async () => {
      const harness = createWorkflowHarness({
        cleanupError: new Error("unlink failed"),
      });

      const outcome = await runReview({ harness });
      assert.equal(outcome.type, "blocked");
      assert.match(outcome.reason, /could not be cleaned: unlink failed/);
      assert.equal(harness.getCleanupCount(), 1);
    });
  });
});
