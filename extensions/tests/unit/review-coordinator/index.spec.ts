import type { ReviewDecisionOutcome } from "#/review-prompts/index.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coordinateReview } from "#/review-coordinator/index.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type ExternalValue = {
  review: string;
};

type TestExternalOutcome =
  | { type: "decided"; value: ExternalValue }
  | { type: "failed"; error: unknown };

type TestCancellationOutcome =
  | { type: "not-started" }
  | { type: "cancelled" }
  | { type: "already-completed" }
  | { type: "unconfirmed"; error?: unknown };

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function allowPendingWorkToRun(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createCoordinatorHarness({
  feedback,
  cancellationOutcome = { type: "cancelled" },
}: {
  feedback?: string;
  cancellationOutcome?: TestCancellationOutcome;
} = {}) {
  const externalOutcome = createDeferred<TestExternalOutcome>();
  const promptDecision = createDeferred<ReviewDecisionOutcome>();
  const externalCancellationStarted = createDeferred<void>();
  const feedbackRequestStarted = createDeferred<void>();
  const promptAborted = createDeferred<void>();
  let externalStarts = 0;
  let externalCancellations = 0;
  let decisionRequests = 0;
  let feedbackRequests = 0;
  let promptSignal: AbortSignal | undefined;
  let cancellationImplementation =
    async (): Promise<TestCancellationOutcome> => {
      return cancellationOutcome;
    };
  let feedbackImplementation = async (): Promise<string | undefined> => {
    return feedback;
  };

  return {
    externalOutcome,
    promptDecision,
    externalCancellationStarted: externalCancellationStarted.promise,
    feedbackRequestStarted: feedbackRequestStarted.promise,
    promptAborted: promptAborted.promise,
    dependencies: {
      startExternalReview() {
        externalStarts += 1;

        return {
          outcome: externalOutcome.promise,
          async cancel() {
            externalCancellations += 1;
            externalCancellationStarted.resolve(undefined);

            return cancellationImplementation();
          },
        };
      },
      requestDecision({ signal }: { signal?: AbortSignal }) {
        decisionRequests += 1;
        promptSignal = signal;
        if (signal?.aborted) {
          promptAborted.resolve(undefined);
        } else {
          signal?.addEventListener(
            "abort",
            () => {
              promptAborted.resolve(undefined);
            },
            { once: true },
          );
        }

        return promptDecision.promise;
      },
      requestFeedback() {
        feedbackRequests += 1;
        feedbackRequestStarted.resolve(undefined);

        return feedbackImplementation();
      },
    },
    observations() {
      return {
        externalStarts,
        externalCancellations,
        decisionRequests,
        feedbackRequests,
        promptSignal,
      };
    },
    setCancellationImplementation(
      implementation: () => Promise<TestCancellationOutcome>,
    ) {
      cancellationImplementation = implementation;
    },
    setFeedbackImplementation(
      implementation: () => Promise<string | undefined>,
    ) {
      feedbackImplementation = implementation;
    },
  };
}

describe("review coordination", () => {
  describe("when the Pi prompt makes the decisive choice", () => {
    it("begins external cancellation before collecting acceptance feedback and awaits both", async () => {
      const feedback = "Continue with the reviewed operation.";
      const cancellation = createDeferred<TestCancellationOutcome>();
      const feedbackResult = createDeferred<string | undefined>();
      const harness = createCoordinatorHarness();
      harness.setCancellationImplementation(() => cancellation.promise);
      harness.setFeedbackImplementation(() => feedbackResult.promise);
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "accepted" });
      await Promise.all([
        harness.externalCancellationStarted,
        harness.feedbackRequestStarted,
      ]);
      assert.equal(harness.observations().externalCancellations, 1);
      assert.equal(harness.observations().feedbackRequests, 1);
      let coordinationSettled = false;
      coordination.then(() => {
        coordinationSettled = true;
      });
      feedbackResult.resolve(feedback);
      await allowPendingWorkToRun();
      assert.equal(coordinationSettled, false);
      cancellation.resolve({ type: "cancelled" });
      assert.deepEqual(await coordination, {
        type: "prompt-accepted",
        feedback,
        externalCancellation: { type: "cancelled" },
      });
    });
    it("preserves rejection when feedback and external cancellation both fail", async () => {
      const feedbackError = new Error("feedback failed");
      const cancellationError = new Error("cancellation failed");
      const harness = createCoordinatorHarness();
      harness.setFeedbackImplementation(async () => {
        throw feedbackError;
      });
      harness.setCancellationImplementation(async () => {
        throw cancellationError;
      });
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "rejected" });
      assert.deepEqual(await coordination, {
        type: "prompt-rejected",
        externalCancellation: {
          type: "unconfirmed",
          error: cancellationError,
        },
      });
      assert.equal(harness.observations().externalCancellations, 1);
      assert.equal(harness.observations().feedbackRequests, 1);
    });
    it("ignores a late external decision after prompt acceptance has settled coordination", async () => {
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "accepted" });
      assert.deepEqual(await coordination, {
        type: "prompt-accepted",
        externalCancellation: { type: "cancelled" },
      });
      harness.externalOutcome.resolve({
        type: "decided",
        value: { review: "late" },
      });
      await allowPendingWorkToRun();
      assert.equal(harness.observations().externalCancellations, 1);
      assert.equal(harness.observations().feedbackRequests, 1);
    });
    it("reports an already-completed external operation without changing prompt acceptance", async () => {
      const harness = createCoordinatorHarness({
        cancellationOutcome: { type: "already-completed" },
      });
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "accepted" });

      assert.deepEqual(await coordination, {
        type: "prompt-accepted",
        externalCancellation: { type: "already-completed" },
      });
    });
    it("reports that external review never started when startup fails before prompt acceptance", async () => {
      const startupError = new Error("startup failed");
      let decisionRequests = 0;
      const coordination = coordinateReview<ExternalValue>({
        input: { hasUI: true },
        dependencies: {
          startExternalReview() {
            throw startupError;
          },
          async requestDecision() {
            decisionRequests += 1;

            return { type: "accepted" };
          },
          async requestFeedback() {
            return undefined;
          },
        },
      });
      assert.deepEqual(await coordination, {
        type: "prompt-accepted",
        externalCancellation: { type: "not-started" },
      });
      assert.equal(decisionRequests, 1);
    });
  });
  describe("when external review makes the decisive choice", () => {
    it("aborts and awaits the stale prompt before returning the external value", async () => {
      const externalValue = { review: "changed" };
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      let coordinationSettled = false;
      coordination.then(() => {
        coordinationSettled = true;
      });
      harness.externalOutcome.resolve({
        type: "decided",
        value: externalValue,
      });
      await harness.promptAborted;
      assert.equal(harness.observations().promptSignal?.aborted, true);
      assert.equal(coordinationSettled, false);
      harness.promptDecision.resolve({ type: "accepted" });
      assert.deepEqual(await coordination, {
        type: "external-decided",
        value: externalValue,
      });
      assert.equal(harness.observations().externalCancellations, 0);
      assert.equal(harness.observations().feedbackRequests, 0);
    });
    it("remains available after the user dismisses the prompt", async () => {
      const externalValue = { review: "unchanged" };
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "dismissed" });
      await allowPendingWorkToRun();
      harness.externalOutcome.resolve({
        type: "decided",
        value: externalValue,
      });
      assert.deepEqual(await coordination, {
        type: "external-decided",
        value: externalValue,
      });
    });
    it("can decide without starting a Pi prompt when interactive UI is absent", async () => {
      const externalValue = { review: "non-interactive" };
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: false },
        dependencies: harness.dependencies,
      });
      harness.externalOutcome.resolve({
        type: "decided",
        value: externalValue,
      });
      assert.deepEqual(await coordination, {
        type: "external-decided",
        value: externalValue,
      });
      assert.equal(harness.observations().decisionRequests, 0);
    });
  });
  describe("when one review source fails without deciding", () => {
    it("keeps the Pi prompt active after external review fails", async () => {
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      await allowPendingWorkToRun();
      assert.equal(harness.observations().promptSignal?.aborted, false);
      harness.promptDecision.resolve({ type: "accepted" });
      assert.deepEqual(await coordination, {
        type: "prompt-accepted",
        externalCancellation: { type: "cancelled" },
      });
    });
    it("returns dismissal only after external review also fails", async () => {
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "dismissed" });
      await allowPendingWorkToRun();
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      assert.deepEqual(await coordination, {
        type: "dismissed",
        externalError,
      });
    });
    it("normalizes an unexpected external outcome rejection as an external failure", async () => {
      const externalError = new Error("outcome rejected");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: false },
        dependencies: harness.dependencies,
      });
      harness.externalOutcome.reject(externalError);

      assert.deepEqual(await coordination, {
        type: "unavailable",
        externalError,
      });
    });
    it("returns unavailable when external review fails without interactive UI", async () => {
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: false },
        dependencies: harness.dependencies,
      });
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      assert.deepEqual(await coordination, {
        type: "unavailable",
        externalError,
      });
    });
    it("returns unavailable after both an unavailable Pi prompt and external failure", async () => {
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "unavailable" });
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      assert.deepEqual(await coordination, {
        type: "unavailable",
        externalError,
      });
    });
    it("preserves both exact errors when prompt and external review fail", async () => {
      const promptError = new Error("prompt failed");
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.reject(promptError);
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      assert.deepEqual(await coordination, {
        type: "failed",
        promptFailure: { type: "request-failed", error: promptError },
        externalError,
      });
    });
    it("distinguishes unexpected prompt supersession from unavailable UI", async () => {
      const externalError = new Error("editor failed");
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true },
        dependencies: harness.dependencies,
      });
      harness.promptDecision.resolve({ type: "superseded" });
      harness.externalOutcome.resolve({
        type: "failed",
        error: externalError,
      });
      assert.deepEqual(await coordination, {
        type: "failed",
        promptFailure: { type: "unexpected-superseded" },
        externalError,
      });
    });
  });
  describe("when the caller cancels the complete coordination", () => {
    it("does not start either source when the caller signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const harness = createCoordinatorHarness();
      assert.deepEqual(
        await coordinateReview({
          input: { hasUI: true, signal: controller.signal },
          dependencies: harness.dependencies,
        }),
        {
          type: "cancelled",
          externalCancellation: { type: "not-started" },
        },
      );
      assert.equal(harness.observations().externalStarts, 0);
      assert.equal(harness.observations().decisionRequests, 0);
    });
    it("reports unconfirmed external cleanup without changing caller cancellation", async () => {
      const controller = new AbortController();
      const cancellationError = new Error("cancellation failed");
      const harness = createCoordinatorHarness();
      harness.setCancellationImplementation(async () => {
        throw cancellationError;
      });
      const coordination = coordinateReview({
        input: { hasUI: true, signal: controller.signal },
        dependencies: harness.dependencies,
      });
      controller.abort();
      await harness.promptAborted;
      harness.promptDecision.resolve({ type: "superseded" });
      assert.deepEqual(await coordination, {
        type: "cancelled",
        externalCancellation: {
          type: "unconfirmed",
          error: cancellationError,
        },
      });
    });
    it("aborts and awaits the prompt while cancelling external review exactly once", async () => {
      const controller = new AbortController();
      const harness = createCoordinatorHarness();
      const coordination = coordinateReview({
        input: { hasUI: true, signal: controller.signal },
        dependencies: harness.dependencies,
      });
      let coordinationSettled = false;
      coordination.then(() => {
        coordinationSettled = true;
      });
      controller.abort();
      await Promise.all([
        harness.promptAborted,
        harness.externalCancellationStarted,
      ]);
      assert.equal(harness.observations().promptSignal?.aborted, true);
      assert.equal(harness.observations().externalCancellations, 1);
      assert.equal(coordinationSettled, false);
      harness.promptDecision.resolve({ type: "superseded" });
      assert.deepEqual(await coordination, {
        type: "cancelled",
        externalCancellation: { type: "cancelled" },
      });
      harness.externalOutcome.resolve({
        type: "decided",
        value: { review: "late" },
      });
      await allowPendingWorkToRun();
      assert.equal(harness.observations().externalCancellations, 1);
    });
  });
});
