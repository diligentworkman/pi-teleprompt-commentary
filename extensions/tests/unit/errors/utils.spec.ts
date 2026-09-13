import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attempt,
  getErrorMessage,
  isErrorWithCode,
  toError,
} from "#/errors/index.ts";

describe("error utilities", () => {
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
