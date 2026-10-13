import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchHookCommands } from "#/event-hooks/index.ts";
import { coordinateReview } from "#/review-coordinator/index.ts";
import { requestReviewDecision } from "#/review-prompts/index.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

describe("best-effort hook dispatch", () => {
  it("does not announce a prompt superseded by external review while hook resolution is pending", async () => {
    const resolving = createDeferred<void>();
    const promptAborted = createDeferred<void>();
    const commands = createDeferred<Array<[string]>>();
    const external = createDeferred<{ type: "decided"; value: string }>();
    const started: Array<string> = [];
    let selections = 0;
    const review = coordinateReview({
      input: { hasUI: true },
      dependencies: {
        startExternalReview() {
          return {
            outcome: external.promise,
            async cancel() {
              return { type: "already-completed" };
            },
          };
        },
        async requestDecision(input) {
          input.signal?.addEventListener("abort", () => promptAborted.resolve(), { once: true });
          await dispatchHookCommands({
            resolveCommands() {
              resolving.resolve();

              return commands.promise;
            },
            shouldDispatch: () => !input.signal?.aborted,
            processRunner: {
              start({ command }) {
                started.push(command[0]);

                return {
                  completion: Promise.resolve({ type: "exited", exitCode: 0, signal: null }),
                  async terminate() {
                    return { type: "already-exited" };
                  },
                };
              },
              async cleanup() {
                return [];
              },
            },
          });

          return requestReviewDecision({
            input,
            dependencies: {
              async selectReviewDecision() {
                selections += 1;

                return "Accept";
              },
            },
          });
        },
        async requestFeedback() {
          return undefined;
        },
      },
    });
    await resolving.promise;
    external.resolve({ type: "decided", value: "editor accepted" });
    await promptAborted.promise;
    commands.resolve([["permission-hook"]]);
    assert.deepEqual(await review, { type: "external-decided", value: "editor accepted" });
    assert.deepEqual(started, []);
    assert.equal(selections, 0);
  });
  it("starts every command in order despite startup, rejection, and nonzero-exit failures", async () => {
    const started: Array<string> = [];
    await dispatchHookCommands({
      async resolveCommands() { return [["startup-failure"], ["rejection"], ["nonzero"], ["last", "fixed argument"]]; },
      processRunner: {
        start({ command }) {
          started.push(command[0]);
          if (command[0] === "startup-failure") throw new Error("spawn failed");
          return {
            completion: command[0] === "rejection"
              ? Promise.reject(new Error("observation failed"))
              : Promise.resolve({ type: "exited", exitCode: 2, signal: null }),
            async terminate() { return { type: "already-exited" }; },
          };
        },
        async cleanup() { return []; },
      },
    });
    assert.deepEqual(started, ["startup-failure", "rejection", "nonzero", "last"]);
  });

  it("swallows resolver failures without starting a process", async () => {
    await dispatchHookCommands({
      async resolveCommands() { throw new Error("resolver failed"); },
      processRunner: {
        start() { assert.fail("No resolved commands"); },
        async cleanup() { return []; },
      },
    });
  });
});
