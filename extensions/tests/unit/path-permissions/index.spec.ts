import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestWorkspacePathPermission,
  type WorkspacePathAssessment,
} from "#/path-permissions/index.ts";
import {
  blockReasonMessages,
  errorMessageTemplates,
  permissionPromptMessages,
} from "#/path-permissions/messages.ts";

function createInteraction(allowed: boolean) {
  const emittedToolNames: Array<string> = [];
  const decisionRequests: Array<{ title: string; message: string }> = [];

  return {
    emittedToolNames,
    decisionRequests,
    async runPermissionRequestHook(toolName: string) {
      emittedToolNames.push(toolName);
    },
    async confirmOutsideWorkspaceAccess(request: {
      title: string;
      message: string;
    }) {
      decisionRequests.push(request);
      return allowed;
    },
  };
}

describe("workspace path permission", () => {
  const toolName = "read";
  it("allows inside paths without running the hook or asking the user", async () => {
    const interaction = createInteraction(false);
    const outcome = await requestWorkspacePathPermission({
      input: {
        assessment: { type: "inside", canonicalPaths: ["/workspace/file.ts"] },
        toolName,
        hasUI: true,
      },
      dependencies: interaction,
    });
    assert.deepEqual(outcome, { type: "allowed" });
    assert.deepEqual(interaction.emittedToolNames, []);
    assert.deepEqual(interaction.decisionRequests, []);
  });
  it("blocks an unresolved path without running the hook or asking the user", async () => {
    const interaction = createInteraction(true);
    const error = new Error("permission denied");
    const outcome = await requestWorkspacePathPermission({
      input: {
        assessment: { type: "resolution-failed", path: "/restricted", error },
        toolName,
        hasUI: true,
      },
      dependencies: interaction,
    });
    assert.deepEqual(outcome, {
      type: "blocked",
      reason: errorMessageTemplates.resolutionFailed({
        path: "/restricted",
        errorMessage: error.message,
      }),
    });
    assert.deepEqual(interaction.emittedToolNames, []);
    assert.deepEqual(interaction.decisionRequests, []);
  });
  it("emits one request and asks once for all outside paths", async () => {
    const interaction = createInteraction(true);
    const outsidePaths = ["/external/first.ts", "/external/second.ts"];
    const assessment: WorkspacePathAssessment = {
      type: "outside",
      canonicalPaths: outsidePaths,
      outsidePaths,
    };
    const outcome = await requestWorkspacePathPermission({
      input: { assessment, toolName, hasUI: true },
      dependencies: interaction,
    });
    assert.deepEqual(outcome, { type: "allowed" });
    assert.deepEqual(interaction.emittedToolNames, [toolName]);
    assert.deepEqual(interaction.decisionRequests, [
      {
        title: permissionPromptMessages.title,
        message: permissionPromptMessages.body({ toolName, outsidePaths }),
      },
    ]);
  });
  it("blocks when permission is not granted", async () => {
    const interaction = createInteraction(false);
    const outcome = await requestWorkspacePathPermission({
      input: {
        assessment: {
          type: "outside",
          canonicalPaths: ["/external/file.ts"],
          outsidePaths: ["/external/file.ts"],
        },
        toolName,
        hasUI: true,
      },
      dependencies: interaction,
    });
    assert.deepEqual(outcome, {
      type: "blocked",
      reason: blockReasonMessages.permissionNotGranted,
    });
  });
  it("fails closed without UI after emitting the permission request", async () => {
    const interaction = createInteraction(true);
    const outcome = await requestWorkspacePathPermission({
      input: {
        assessment: {
          type: "outside",
          canonicalPaths: ["/external/file.ts"],
          outsidePaths: ["/external/file.ts"],
        },
        toolName,
        hasUI: false,
      },
      dependencies: interaction,
    });
    assert.deepEqual(outcome, {
      type: "blocked",
      reason: blockReasonMessages.uiUnavailable,
    });
    assert.deepEqual(interaction.emittedToolNames, [toolName]);
    assert.deepEqual(interaction.decisionRequests, []);
  });
  it("continues to the permission decision when the hook fails", async () => {
    const interaction = createInteraction(true);
    const outcome = await requestWorkspacePathPermission({
      input: {
        assessment: {
          type: "outside",
          canonicalPaths: ["/external/file.ts"],
          outsidePaths: ["/external/file.ts"],
        },
        toolName,
        hasUI: true,
      },
      dependencies: {
        ...interaction,
        async runPermissionRequestHook() {
          throw new Error("hook failed");
        },
      },
    });
    assert.deepEqual(outcome, { type: "allowed" });
    assert.equal(interaction.decisionRequests.length, 1);
  });
});
