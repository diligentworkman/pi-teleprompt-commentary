import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestOptionalReviewFeedback,
  requestReviewDecision,
} from "#/review-prompts/index.ts";
import {
  reviewDecisionMessages,
  reviewFeedbackMessageTemplates,
} from "#/review-prompts/messages.ts";

type SelectionRequest = {
  title: string;
  options: Array<string>;
  signal?: AbortSignal;
};

function createDecisionInteraction(selection?: string) {
  const selectionRequests: Array<SelectionRequest> = [];

  return {
    selectionRequests,
    async selectReviewDecision(request: SelectionRequest) {
      selectionRequests.push(request);
      return selection;
    },
  };
}

type FeedbackRequest = {
  title: string;
  placeholder: string;
  signal?: AbortSignal;
};

function createFeedbackInteraction(feedback?: string) {
  const feedbackRequests: Array<FeedbackRequest> = [];

  return {
    feedbackRequests,
    async requestReviewFeedback(request: FeedbackRequest) {
      feedbackRequests.push(request);
      return feedback;
    },
  };
}

describe("review prompts", () => {
  describe("review decision prompt", () => {
    it("returns accepted after the user selects Accept", async () => {
      const interaction = createDecisionInteraction("Accept");
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: true },
          dependencies: interaction,
        }),
        { type: "accepted" },
      );
      assert.deepEqual(interaction.selectionRequests, [
        {
          title: reviewDecisionMessages.title,
          options: reviewDecisionMessages.options,
          signal: undefined,
        },
      ]);
    });
    it("returns rejected after the user selects Reject", async () => {
      const interaction = createDecisionInteraction("Reject");
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: true },
          dependencies: interaction,
        }),
        { type: "rejected" },
      );
    });
    it("returns dismissed when the user closes the selector", async () => {
      const interaction = createDecisionInteraction();
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: true },
          dependencies: interaction,
        }),
        { type: "dismissed" },
      );
    });
    it("returns unavailable without opening a selector when UI is absent", async () => {
      const interaction = createDecisionInteraction("Accept");
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: false },
          dependencies: interaction,
        }),
        { type: "unavailable" },
      );
      assert.deepEqual(interaction.selectionRequests, []);
    });
    it("returns superseded without opening a selector when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const interaction = createDecisionInteraction("Accept");
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: true, signal: controller.signal },
          dependencies: interaction,
        }),
        { type: "superseded" },
      );
      assert.deepEqual(interaction.selectionRequests, []);
    });
    it("returns superseded when another source aborts the active selector", async () => {
      const controller = new AbortController();
      const selectionRequests: Array<SelectionRequest> = [];
      assert.deepEqual(
        await requestReviewDecision({
          input: { hasUI: true, signal: controller.signal },
          dependencies: {
            async selectReviewDecision(request) {
              selectionRequests.push(request);
              controller.abort();
              return undefined;
            },
          },
        }),
        { type: "superseded" },
      );
      assert.deepEqual(selectionRequests, [
        {
          title: reviewDecisionMessages.title,
          options: reviewDecisionMessages.options,
          signal: controller.signal,
        },
      ]);
    });
  });
  describe("optional review feedback", () => {
    for (const decision of ["accepted", "rejected"] as const) {
      it(`requests and preserves ${decision} feedback`, async () => {
        const feedback = `Please note this ${decision} decision.`;
        const interaction = createFeedbackInteraction(feedback);
        assert.equal(
          await requestOptionalReviewFeedback({
            input: { decision, hasUI: true },
            dependencies: interaction,
          }),
          feedback,
        );
        assert.deepEqual(interaction.feedbackRequests, [
          {
            title: reviewFeedbackMessageTemplates.title(decision),
            placeholder: reviewFeedbackMessageTemplates.placeholder(),
            signal: undefined,
          },
        ]);
      });
    }
    it("treats cancelled feedback as absent", async () => {
      const interaction = createFeedbackInteraction();
      assert.equal(
        await requestOptionalReviewFeedback({
          input: { decision: "accepted", hasUI: true },
          dependencies: interaction,
        }),
        undefined,
      );
    });
    it("treats empty feedback as absent", async () => {
      const interaction = createFeedbackInteraction("");
      assert.equal(
        await requestOptionalReviewFeedback({
          input: { decision: "rejected", hasUI: true },
          dependencies: interaction,
        }),
        undefined,
      );
    });
    it("does not request feedback without UI", async () => {
      const interaction = createFeedbackInteraction("feedback");
      assert.equal(
        await requestOptionalReviewFeedback({
          input: { decision: "accepted", hasUI: false },
          dependencies: interaction,
        }),
        undefined,
      );
      assert.deepEqual(interaction.feedbackRequests, []);
    });
    it("does not request feedback after the interaction is aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const interaction = createFeedbackInteraction("feedback");
      assert.equal(
        await requestOptionalReviewFeedback({
          input: {
            decision: "rejected",
            hasUI: true,
            signal: controller.signal,
          },
          dependencies: interaction,
        }),
        undefined,
      );
      assert.deepEqual(interaction.feedbackRequests, []);
    });
  });
});
