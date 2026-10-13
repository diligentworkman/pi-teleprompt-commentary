import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attempt,
  attemptWithCleanup,
  getErrorMessage,
  isErrorWithCode,
  toError,
} from "#/errors/index.ts";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

describe("error utilities", () => {
  describe("attemptWithCleanup", () => {
    const primaryError = new Error("primary operation failed");
    const cleanupError = new Error("cleanup failed");
    const value = { status: "complete" };
    const cases = [
      { description: "preserves the returned value when operation and cleanup succeed", operationFails: false, cleanupFails: false },
      { description: "runs cleanup after operation failure and preserves the exact primary error", operationFails: true, cleanupFails: false },
      { description: "reports the exact cleanup error after a successful operation", operationFails: false, cleanupFails: true },
      { description: "preserves the exact primary error when both operation and cleanup fail", operationFails: true, cleanupFails: true },
    ];
    for (const { description, operationFails, cleanupFails } of cases) {
      it(description, async () => {
        const calls: Array<string> = [];
        const result = await attemptWithCleanup({
          async operation() {
            calls.push("operation");
            if (operationFails) {
              throw primaryError;
            }

            return value;
          },
          async cleanup() {
            calls.push("cleanup");
            if (cleanupFails) {
              throw cleanupError;
            }
          },
        });
        assert.deepEqual(calls, ["operation", "cleanup"]);
        if (operationFails || cleanupFails) {
          assert.equal(result.success, false);
          assert.equal(result.error, operationFails ? primaryError : cleanupError);
        } else {
          assert.equal(result.success, true);
          assert.equal(result.value, value);
        }
      });
    }
    it("preserves a synchronously thrown undefined primary error even when cleanup also fails", async () => {
      let cleanupCalls = 0;
      const result = await attemptWithCleanup({
        operation() {
          throw undefined;
        },
        async cleanup() {
          cleanupCalls += 1;
          throw cleanupError;
        },
      });
      assert.equal(result.success, false);
      assert.equal(result.error, undefined);
      assert.equal(cleanupCalls, 1);
    });
    it("waits for cleanup completion before returning the operation value", async () => {
      const cleanupStarted = createDeferred<void>();
      const cleanupFinished = createDeferred<void>();
      let settled = false;
      const result = attemptWithCleanup({
        async operation() {
          return value;
        },
        cleanup() {
          cleanupStarted.resolve();

          return cleanupFinished.promise;
        },
      }).then((outcome) => {
        settled = true;

        return outcome;
      });
      await cleanupStarted.promise;
      assert.equal(settled, false);
      cleanupFinished.resolve();
      assert.equal((await result).value, value);
      assert.equal(settled, true);
    });
  });
  describe("attempt", () => {
    it("constructs explicit value and error results", () => {
      const value = { status: "ready" };
      const error = new Error("failed");
      assert.deepEqual(attempt.value(value), {
        success: true,
        value,
        error: undefined,
      });
      assert.deepEqual(attempt.error(error), {
        success: false,
        value: undefined,
        error,
      });
    });
    describe("when the operation is synchronous", () => {
      it("returns the operation value in a successful attempt result", () => {
        const value = { status: "ready" };
        assert.deepEqual(attempt.sync(() => value), {
          success: true,
          value,
          error: undefined,
        });
      });
      it("preserves the exact value thrown by the operation", () => {
        const error = new Error("failed");
        const result = attempt.sync(() => {
          throw error;
        });
        assert.equal(result.success, false);
        assert.equal(result.value, undefined);
        assert.equal(result.error, error);
      });
      it("distinguishes a returned undefined value from a thrown undefined value", () => {
        assert.deepEqual(attempt.sync(() => undefined), {
          success: true,
          value: undefined,
          error: undefined,
        });
        assert.deepEqual(
          attempt.sync(() => {
            throw undefined;
          }),
          {
            success: false,
            value: undefined,
            error: undefined,
          },
        );
      });
    });
    it("returns a successful resolved value", async () => {
      const value = { status: "ready" };
      assert.deepEqual(await attempt(async () => value), {
        success: true,
        value,
        error: undefined,
      });
    });
    it("preserves the exact rejected value", async () => {
      const error = new Error("failed");
      const result = await attempt(async () => {
        throw error;
      });
      assert.equal(result.success, false);
      assert.equal(result.value, undefined);
      assert.equal(result.error, error);
    });
    it("distinguishes a successful undefined value from thrown undefined", async () => {
      assert.deepEqual(await attempt(async () => undefined), {
        success: true,
        value: undefined,
        error: undefined,
      });
      assert.deepEqual(
        await attempt(async () => {
          throw undefined;
        }),
        {
          success: false,
          value: undefined,
          error: undefined,
        },
      );
    });
  });
  it("reads Error messages and stringifies other thrown values", () => {
    assert.equal(getErrorMessage(new Error("failed")), "failed");
    assert.equal(getErrorMessage("failed"), "failed");
    assert.equal(getErrorMessage({ reason: "failed" }), "[object Object]");
  });
  it("matches a code only on Error instances carrying that exact code", () => {
    const missingError = Object.assign(new Error("missing"), {
      code: "ENOENT",
    });
    assert.equal(
      isErrorWithCode({ error: missingError, code: "ENOENT" }),
      true,
    );
    assert.equal(
      isErrorWithCode({ error: missingError, code: "EEXIST" }),
      false,
    );
    assert.equal(
      isErrorWithCode({ error: { code: "ENOENT" }, code: "ENOENT" }),
      false,
    );
  });
  it("preserves Error instances and wraps other thrown values", () => {
    const error = new Error("failed");
    assert.equal(toError(error), error);
    assert.deepEqual(toError("failed"), new Error("failed"));
  });
});
