import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPathReservationRegistry } from "#/path-reservations/index.ts";

describe("path reservation registry", () => {
  const canonicalPath = "/workspaces/primary/file.ts";
  const firstToolCallId = "first-tool-call";
  const secondToolCallId = "second-tool-call";
  it("acquires an unreserved canonical path", () => {
    const registry = createPathReservationRegistry();
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: firstToolCallId }),
      { type: "acquired" },
    );
  });
  it("reports the path and current owner when another call conflicts", () => {
    const registry = createPathReservationRegistry();
    registry.acquire({ canonicalPath, toolCallId: firstToolCallId });
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: secondToolCallId }),
      {
        type: "conflict",
        canonicalPath,
        currentOwnerToolCallId: firstToolCallId,
      },
    );
  });
  it("allows the owning tool call to reacquire the same path", () => {
    const registry = createPathReservationRegistry();
    registry.acquire({ canonicalPath, toolCallId: firstToolCallId });
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: firstToolCallId }),
      { type: "acquired" },
    );
  });
  it("releases every path owned by a tool call", () => {
    const registry = createPathReservationRegistry();
    const secondCanonicalPath = "/workspaces/primary/other.ts";
    registry.acquire({ canonicalPath, toolCallId: firstToolCallId });
    registry.acquire({
      canonicalPath: secondCanonicalPath,
      toolCallId: firstToolCallId,
    });
    registry.releaseByToolCallId(firstToolCallId);
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: secondToolCallId }),
      { type: "acquired" },
    );
    assert.deepEqual(
      registry.acquire({
        canonicalPath: secondCanonicalPath,
        toolCallId: secondToolCallId,
      }),
      { type: "acquired" },
    );
  });
  it("does not release reservations owned by another tool call", () => {
    const registry = createPathReservationRegistry();
    registry.acquire({ canonicalPath, toolCallId: firstToolCallId });
    registry.releaseByToolCallId(secondToolCallId);
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: secondToolCallId }),
      {
        type: "conflict",
        canonicalPath,
        currentOwnerToolCallId: firstToolCallId,
      },
    );
  });
  it("clears every reservation and remains safe to clear or release again", () => {
    const registry = createPathReservationRegistry();
    registry.acquire({ canonicalPath, toolCallId: firstToolCallId });
    registry.clear();
    registry.clear();
    registry.releaseByToolCallId(firstToolCallId);
    assert.deepEqual(
      registry.acquire({ canonicalPath, toolCallId: secondToolCallId }),
      { type: "acquired" },
    );
  });
});
