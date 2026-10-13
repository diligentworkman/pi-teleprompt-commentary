import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startFileExternalReview } from "#/file-review/external.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";

function harness(completion: Promise<ProcessCompletion>, proposal: () => Promise<Buffer>) {
  const commands: Array<Array<string>> = [];
  let terminationCount = 0;
  const processRunner: ProcessRunner = {
    start({ command }) {
      commands.push(command);
      return {
        completion,
        async terminate() {
          terminationCount++;
          return { type: "termination-observed" };
        },
      };
    },
    async cleanup() { return []; },
  };
  const operation = startFileExternalReview({
    input: {
      command: ["editor", "--wait", "/proposal"],
      proposalPath: "/proposal",
      originalProposal: Buffer.from("proposal"),
    },
    dependencies: {
      processRunner,
      readProposal: async (path) => {
        assert.equal(path, "/proposal");
        return proposal();
      },
    },
  });
  return { operation, commands, getTerminationCount: () => terminationCount };
}

const successfulExit: ProcessCompletion = { type: "exited", exitCode: 0, signal: null };

describe("file external review process adaptation", () => {
  it("passes direct argv and reports unchanged proposal bytes", async () => {
    const review = harness(Promise.resolve(successfulExit), async () => Buffer.from("proposal"));
    assert.deepEqual(review.commands, [["editor", "--wait", "/proposal"]]);
    assert.deepEqual(await review.operation.outcome, { type: "decided", value: { type: "unchanged" } });
  });

  it("reports changed bytes, including an empty reviewed file", async () => {
    const review = harness(Promise.resolve(successfulExit), async () => Buffer.alloc(0));
    assert.deepEqual(await review.operation.outcome, {
      type: "decided",
      value: { type: "changed", content: Buffer.alloc(0) },
    });
  });

  it("preserves a failed process without reading the proposal", async () => {
    const completion: ProcessCompletion = { type: "exited", exitCode: 2, signal: null };
    const review = harness(Promise.resolve(completion), async () => {
      assert.fail("Must not read after failed editor exit");
    });
    assert.deepEqual(await review.operation.outcome, {
      type: "failed", error: { type: "process-failed", completion },
    });
  });

  it("preserves a proposal read failure", async () => {
    const failure = new Error("read failed");
    const review = harness(Promise.resolve(successfulExit), async () => { throw failure; });
    assert.deepEqual(await review.operation.outcome, {
      type: "failed", error: { type: "proposal-read-failed", error: failure },
    });
  });

  it("coalesces cancellation requests", async () => {
    const review = harness(Promise.resolve(successfulExit), async () => Buffer.from("proposal"));
    const first = review.operation.cancel();
    const second = review.operation.cancel();
    assert.equal(first, second);
    assert.deepEqual(await first, { type: "cancelled" });
    assert.equal(review.getTerminationCount(), 1);
  });
});
