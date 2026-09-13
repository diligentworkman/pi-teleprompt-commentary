import type {
  CustomEntry,
  SessionEntry,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt, getErrorMessage } from "#/errors/index.ts";
import { registerTelepromptCommentary } from "#/index.ts";
import {
  blockReasonMessages,
  errorMessageTemplates,
  permissionPromptMessages,
} from "#/path-permissions/messages.ts";
import type { ProcessCompletion } from "#/process/index.ts";
import { workspaceEntryType } from "#/workspaces/index.ts";

type ConfirmationRequest = {
  title: string;
  message: string;
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-path-gate-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

function createWorkspaceBranch(additionalWorkspaces: Array<string>) {
  return [
    {
      type: "custom",
      customType: workspaceEntryType,
      id: "workspace-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { additionalWorkspaces },
    } satisfies CustomEntry,
  ];
}

function createPathPermissionHarness({
  confirmResult = true,
  configurationSource = "",
  processCompletions = [],
}: {
  confirmResult?: boolean;
  configurationSource?: string;
  processCompletions?: Array<Promise<ProcessCompletion>>;
} = {}) {
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const observedConfirmations: Array<ConfirmationRequest> = [];
  const processCommands: Array<Array<string>> = [];
  let activeBranch: Array<SessionEntry> = [];
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: "/config/teleprompt-commentary/config.toml",
      fileSystem: {
        async createDirectory() {
          throw new Error(
            "Path permission wiring must not create directories.",
          );
        },
        async createFileExclusively() {
          throw new Error("Path permission wiring must not create files.");
        },
        async readFile() {
          throw new Error("Path permission wiring must not read config files.");
        },
      },
      processRunner: {
        start({ command }) {
          const completion = processCompletions.shift();
          if (completion === undefined) {
            throw new Error("The process runner was not expected to start.");
          }
          processCommands.push(command);

          return {
            completion,
            async terminate() {
              return { type: "already-exited" as const };
            },
          };
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return configurationSource;
      },
      async readStarterConfigurationSource() {
        throw new Error("Path permission wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Path permission wiring must not save config.");
      },
    },
  });
  function createContext(cwd: string, hasUI: boolean) {
    return {
      cwd,
      hasUI,
      sessionManager: {
        getBranch() {
          return activeBranch;
        },
      },
      ui: {
        async confirm(title: string, message: string) {
          observedConfirmations.push({ title, message });
          return confirmResult;
        },
      },
    };
  }

  return {
    observedConfirmations,
    processCommands,
    async restore({
      cwd,
      additionalWorkspaces = [],
    }: {
      cwd: string;
      additionalWorkspaces?: Array<string>;
    }) {
      activeBranch = createWorkspaceBranch(additionalWorkspaces);
      const handlers = eventHandlers.get("session_start");
      if (!handlers || handlers.length !== 1) {
        throw new Error("The harness requires one session-start handler.");
      }
      await handlers[0]({ type: "session_start" }, createContext(cwd, true));
    },
    async toolCall({
      event,
      cwd,
      hasUI = true,
    }: {
      event: ToolCallEvent;
      cwd: string;
      hasUI?: boolean;
    }) {
      const handlers = eventHandlers.get("tool_call");
      if (!handlers || handlers.length !== 1) {
        throw new Error("The harness requires one tool-call handler.");
      }

      return handlers[0](event, createContext(cwd, hasUI));
    },
  };
}

describe("path permission wiring", () => {
  it("automatically permits every supported path tool inside primary or additional workspaces", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const additionalWorkspace = join(cwd, "additional");
    await mkdir(additionalWorkspace);
    const primaryPath = join(cwd, "primary.txt");
    const additionalPath = join(additionalWorkspace, "additional.txt");
    const toolCallId = "tool-call";
    const events = [
      {
        type: "tool_call",
        toolCallId,
        toolName: "read",
        input: { path: primaryPath },
      },
      {
        type: "tool_call",
        toolCallId,
        toolName: "write",
        input: { path: additionalPath, content: "content" },
      },
      {
        type: "tool_call",
        toolCallId,
        toolName: "edit",
        input: { path: primaryPath, edits: [] },
      },
      {
        type: "tool_call",
        toolCallId,
        toolName: "grep",
        input: { path: additionalPath, pattern: "pattern" },
      },
      {
        type: "tool_call",
        toolCallId,
        toolName: "find",
        input: { path: cwd, pattern: "*.ts" },
      },
      {
        type: "tool_call",
        toolCallId,
        toolName: "ls",
        input: {},
      },
    ] satisfies Array<ToolCallEvent>;
    const harness = createPathPermissionHarness();
    await harness.restore({
      cwd,
      additionalWorkspaces: [additionalWorkspace],
    });
    for (const event of events) {
      assert.equal(await harness.toolCall({ event, cwd }), undefined);
    }
    assert.deepEqual(harness.observedConfirmations, []);
  });
  it("runs the configured hook and prompts once for outside access", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const outsidePath = join(cwd, "..", "outside.txt");
    const harness = createPathPermissionHarness({
      configurationSource: [
        "[[hooks.tool_permission_request]]",
        'action = ["permission-hook", { var = "tool_name" }]',
      ].join("\n"),
      processCompletions: [
        Promise.resolve({ type: "exited", exitCode: 0, signal: null }),
      ],
    });
    await harness.restore({ cwd });
    const result = await harness.toolCall({
      cwd,
      event: {
        type: "tool_call",
        toolCallId: "outside-read",
        toolName: "read",
        input: { path: outsidePath },
      },
    });
    assert.equal(result, undefined);
    assert.deepEqual(harness.processCommands, [["permission-hook", "read"]]);
    assert.deepEqual(harness.observedConfirmations, [
      {
        title: permissionPromptMessages.title,
        message: permissionPromptMessages.body({
          toolName: "read",
          outsidePaths: [outsidePath],
        }),
      },
    ]);
  });
  it("fails closed for outside access without UI", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const outsidePath = join(cwd, "..", "outside.txt");
    const harness = createPathPermissionHarness();
    await harness.restore({ cwd });
    assert.deepEqual(
      await harness.toolCall({
        cwd,
        hasUI: false,
        event: {
          type: "tool_call",
          toolCallId: "outside-read",
          toolName: "read",
          input: { path: outsidePath },
        },
      }),
      {
        block: true,
        reason: blockReasonMessages.uiUnavailable,
      },
    );
  });
  it("blocks outside access when interactive permission is denied", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const outsidePath = join(cwd, "..", "outside.txt");
    const harness = createPathPermissionHarness({ confirmResult: false });
    await harness.restore({ cwd });

    assert.deepEqual(
      await harness.toolCall({
        cwd,
        event: {
          type: "tool_call",
          toolCallId: "denied-read",
          toolName: "read",
          input: { path: outsidePath },
        },
      }),
      {
        block: true,
        reason: blockReasonMessages.permissionNotGranted,
      },
    );
    assert.deepEqual(harness.observedConfirmations, [
      {
        title: permissionPromptMessages.title,
        message: permissionPromptMessages.body({
          toolName: "read",
          outsidePaths: [outsidePath],
        }),
      },
    ]);
  });
  it("fails closed before hooks or confirmation when canonical resolution fails", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const loopPath = join(cwd, "loop");
    const unresolvedPath = join(loopPath, "file.txt");
    await symlink("loop", loopPath);
    const expectedResolution = await attempt(() => realpath(unresolvedPath));
    assert.equal(expectedResolution.success, false);
    if (expectedResolution.success) {
      assert.fail("Expected the symlink loop to prevent canonical resolution.");
    }
    const harness = createPathPermissionHarness({
      configurationSource: [
        "[[hooks.tool_permission_request]]",
        'action = ["permission-hook", { var = "tool_name" }]',
      ].join("\n"),
      processCompletions: [
        Promise.resolve({ type: "exited", exitCode: 0, signal: null }),
      ],
    });
    await harness.restore({ cwd });
    assert.deepEqual(
      await harness.toolCall({
        cwd,
        event: {
          type: "tool_call",
          toolCallId: "unresolved-read",
          toolName: "read",
          input: { path: unresolvedPath },
        },
      }),
      {
        block: true,
        reason: errorMessageTemplates.resolutionFailed({
          path: unresolvedPath,
          errorMessage: getErrorMessage(expectedResolution.error),
        }),
      },
    );
    assert.deepEqual(harness.processCommands, []);
    assert.deepEqual(harness.observedConfirmations, []);
  });
  it("does not infer path permissions for custom tools", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createPathPermissionHarness();
    assert.equal(
      await harness.toolCall({
        cwd,
        event: {
          type: "tool_call",
          toolCallId: "custom-tool",
          toolName: "deploy",
          input: { path: join(cwd, "..", "outside.txt") },
        },
      }),
      undefined,
    );
    assert.deepEqual(harness.observedConfirmations, []);
  });
});
