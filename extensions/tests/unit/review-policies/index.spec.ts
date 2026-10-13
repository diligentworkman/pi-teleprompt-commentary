import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewDecisionOutcome } from "#/review-prompts/index.ts";
import {
  evaluateReviewPolicy,
  conductPromptReview,
  resolveReviewPolicy,
} from "#/review-policies/index.ts";
import type {
  PromptReviewInput,
  PromptReviewOutcome,
} from "#/review-policies/types.ts";
import { reviewPolicyBlockMessageTemplates } from "#/review-policies/messages.ts";

type PromptReviewInteractionInput = {
  decisionOutcome?: ReviewDecisionOutcome;
  decisionError?: unknown;
  feedback?: string;
  feedbackError?: unknown;
};

function createPromptReviewInteraction({
  decisionOutcome = { type: "accepted" },
  decisionError,
  feedback,
  feedbackError,
}: PromptReviewInteractionInput) {
  return {
    async requestDecision() {
      if (decisionError !== undefined) {
        throw decisionError;
      }
      return decisionOutcome;
    },
    async requestFeedback() {
      if (feedbackError !== undefined) {
        throw feedbackError;
      }
      return feedback;
    },
  };
}

describe("review policies", () => {
  describe("review policy resolution", () => {
    it("defaults file review to prompt", () => {
      assert.equal(
        resolveReviewPolicy({ subject: "file", configuredAction: undefined }),
        "prompt",
      );
    });
    it("defaults command review to normal allowed execution", () => {
      assert.equal(
        resolveReviewPolicy({
          subject: "command",
          configuredAction: undefined,
        }),
        "allow",
      );
    });
    for (const decision of ["allow", "deny", "prompt"] as const) {
      it(`preserves a configured ${decision} decision`, () => {
        assert.equal(
          resolveReviewPolicy({
            subject: "file",
            configuredAction: decision,
          }),
          decision,
        );
      });
    }
    it("preserves a configured external review command", () => {
      const command = ["reviewer", "--wait", "/tmp/review"] as [
        string,
        ...Array<string>,
      ];
      assert.equal(
        resolveReviewPolicy({
          subject: "command",
          configuredAction: command,
        }),
        command,
      );
    });
  });
  describe("review policy evaluation", () => {
    function createReviewPolicyEvaluationInteraction(
      promptOutcome: PromptReviewOutcome = { type: "allowed" },
    ) {
      const promptInputs: Array<PromptReviewInput> = [];

      return {
        promptInputs,
        async conductPromptReview(input: PromptReviewInput) {
          promptInputs.push(input);
          return promptOutcome;
        },
      };
    }
    it("allows without prompting when policy is allow", async () => {
      const interaction = createReviewPolicyEvaluationInteraction();
      assert.deepEqual(
        await evaluateReviewPolicy({
          input: { policy: "allow", hasUI: true },
          dependencies: interaction,
        }),
        { type: "allowed" },
      );
      assert.deepEqual(interaction.promptInputs, []);
    });
    it("blocks without prompting when policy is deny", async () => {
      const interaction = createReviewPolicyEvaluationInteraction();
      assert.deepEqual(
        await evaluateReviewPolicy({
          input: { policy: "deny", hasUI: true },
          dependencies: interaction,
        }),
        {
          type: "blocked",
          reason: reviewPolicyBlockMessageTemplates.denied(),
        },
      );
      assert.deepEqual(interaction.promptInputs, []);
    });
    it("delegates prompt policy and preserves its outcome", async () => {
      const controller = new AbortController();
      const promptOutcome = { type: "allowed" as const, feedback: "Proceed." };
      const interaction =
        createReviewPolicyEvaluationInteraction(promptOutcome);
      assert.deepEqual(
        await evaluateReviewPolicy({
          input: {
            policy: "prompt",
            hasUI: true,
            signal: controller.signal,
          },
          dependencies: interaction,
        }),
        promptOutcome,
      );
      assert.deepEqual(interaction.promptInputs, [
        { hasUI: true, signal: controller.signal },
      ]);
    });
    it("defers a command policy to external review", async () => {
      const command = ["reviewer", "--wait"] as [string, ...Array<string>];
      const interaction = createReviewPolicyEvaluationInteraction();
      assert.deepEqual(
        await evaluateReviewPolicy({
          input: { policy: command, hasUI: false },
          dependencies: interaction,
        }),
        { type: "external-review-required", command },
      );
      assert.deepEqual(interaction.promptInputs, []);
    });
  });
  describe("prompt review", () => {
    it("allows an accepted call and preserves optional feedback", async () => {
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({
            feedback: "Keep this helper small.",
          }),
        }),
        { type: "allowed", feedback: "Keep this helper small." },
      );
    });
    it("blocks a rejected call with optional feedback", async () => {
      const feedback = "Use the existing helper instead.";
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({
            decisionOutcome: { type: "rejected" },
            feedback,
          }),
        }),
        {
          type: "blocked",
          reason: reviewPolicyBlockMessageTemplates.rejected(feedback),
        },
      );
    });
    for (const decisionOutcome of [
      { type: "dismissed" },
      { type: "unavailable" },
    ] as const) {
      it(`fails closed when the prompt is ${decisionOutcome.type}`, async () => {
        assert.deepEqual(
          await conductPromptReview({
            input: { hasUI: decisionOutcome.type !== "unavailable" },
            dependencies: createPromptReviewInteraction({ decisionOutcome }),
          }),
          {
            type: "blocked",
            reason: reviewPolicyBlockMessageTemplates[decisionOutcome.type](),
          },
        );
      });
    }
    it("leaves a superseded decision to the coordinating source", async () => {
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({
            decisionOutcome: { type: "superseded" },
          }),
        }),
        { type: "superseded" },
      );
    });
    it("fails closed when requesting a decision throws", async () => {
      const error = new Error("selector failed");
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({ decisionError: error }),
        }),
        {
          type: "blocked",
          reason: reviewPolicyBlockMessageTemplates.failed(error.message),
        },
      );
    });
    it("keeps acceptance decisive when optional feedback fails", async () => {
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({
            feedbackError: new Error("input failed"),
          }),
        }),
        { type: "allowed" },
      );
    });
    it("keeps rejection decisive when optional feedback fails", async () => {
      assert.deepEqual(
        await conductPromptReview({
          input: { hasUI: true },
          dependencies: createPromptReviewInteraction({
            decisionOutcome: { type: "rejected" },
            feedbackError: new Error("input failed"),
          }),
        }),
        {
          type: "blocked",
          reason: reviewPolicyBlockMessageTemplates.rejected(),
        },
      );
    });
  });
});
