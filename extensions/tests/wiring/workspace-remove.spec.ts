import type {
  CustomEntry,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import {
  commands as workspaceCommands,
  confirmationMessageTemplates,
  errorMessageTemplates,
  warningMessageTemplates,
  workspaceEntryType,
} from "#/workspaces/index.ts";

type Notification = {
  message: Parameters<ExtensionUIContext["notify"]>[0];
  type: Parameters<ExtensionUIContext["notify"]>[1];
};
type RegisteredCommand = {
  handler(args: string, context: any): Promise<void> | void;
};
type AppendedWorkspaceSnapshot = {
  customType: string;
  data: { additionalWorkspaces: ReadonlyArray<string> };
};
type ConfirmationRequest = { title: string; message: string };
type SelectRequest = { title: string; options: Array<string> };

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-remove-wiring-"));
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

function createWorkspaceRemoveHarness({
  selectResult,
  confirmResult = true,
  appendError,
}: {
  selectResult?: string;
  confirmResult?: boolean;
  appendError?: Error;
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const appendedSnapshots: Array<AppendedWorkspaceSnapshot> = [];
  const lifecycleEvents: Array<string> = [];
  const observedConfirmations: Array<ConfirmationRequest> = [];
  const observedNotifications: Array<Notification> = [];
  const observedSelectRequests: Array<SelectRequest> = [];
  let activeBranch: Array<SessionEntry> = [];
  registerTelepromptCommentary({
    pi: {
      appendEntry(customType: string, data: AppendedWorkspaceSnapshot["data"]) {
        if (appendError !== undefined) throw appendError;
        appendedSnapshots.push({ customType, data });
        lifecycleEvents.push("snapshot-appended");
      },
      on(name: string, handler: (event: any, context: any) => unknown) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
    } as any,
    dependencies: {
      configFilePath: "/config/teleprompt-commentary/config.toml",
      fileSystem: {
        async createDirectory() {
          throw new Error("Remove wiring must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Remove wiring must not create files.");
        },
        async readFile() {
          throw new Error("Remove wiring must not read config files.");
        },
      },
      processRunner: {
        start() {
          throw new Error("Remove wiring must not start processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error("Remove wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Remove wiring must not save config.");
      },
    },
  });
  function createContext(cwd: string, hasUI = true) {
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
        notify(message: string, type: Notification["type"]) {
          observedNotifications.push({ message, type });
        },
        async select(title: string, options: Array<string>) {
          observedSelectRequests.push({ title, options });
          return selectResult;
        },
      },
      async reload() {
        lifecycleEvents.push("reload-started");
      },
    };
  }

  return {
    appendedSnapshots,
    lifecycleEvents,
    observedConfirmations,
    observedNotifications,
    observedSelectRequests,
    async restore(cwd: string, additionalWorkspaces: Array<string>) {
      activeBranch = createWorkspaceBranch(additionalWorkspaces);
      const handlers = eventHandlers.get("session_start");
      if (!handlers || handlers.length !== 1)
        throw new Error("The harness requires one session-start handler.");
      await handlers[0]({ type: "session_start" }, createContext(cwd));
    },
    async remove({
      cwd,
      args = "",
      hasUI = true,
    }: {
      cwd: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(workspaceCommands.remove.name);
      if (!command)
        throw new Error("The harness has no workspace-remove command.");
      await command.handler(args, createContext(cwd, hasUI));
    },
    async list(cwd: string) {
      const command = commands.get(workspaceCommands.list.name);
      if (!command)
        throw new Error("The harness has no workspace-list command.");
      await command.handler("", createContext(cwd));
    },
  };
}

describe("workspace-remove wiring", () => {
  it("selects and removes one stored path without filesystem validation", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const staleWorkspace = join(cwd, "deleted-workspace");
    const retainedWorkspace = join(cwd, "retained-workspace");
    const harness = createWorkspaceRemoveHarness({
      selectResult: staleWorkspace,
    });
    await harness.restore(cwd, [staleWorkspace, retainedWorkspace]);
    await harness.remove({ cwd });
    assert.deepEqual(harness.observedSelectRequests, [
      {
        title: workspaceCommands.remove.selectTitle,
        options: [staleWorkspace, retainedWorkspace],
      },
    ]);
    assert.deepEqual(harness.appendedSnapshots, [
      {
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [retainedWorkspace] },
      },
    ]);
    assert.deepEqual(harness.observedConfirmations, [
      {
        title: workspaceCommands.remove.confirmTitle,
        message: confirmationMessageTemplates.removeWorkspace(staleWorkspace),
      },
    ]);
    assert.deepEqual(harness.observedNotifications, []);
    assert.deepEqual(harness.lifecycleEvents, [
      "snapshot-appended",
      "reload-started",
    ]);
  });
  it("accepts an exact argument and persists an empty list", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "stored-workspace");
    const harness = createWorkspaceRemoveHarness();
    await harness.restore(cwd, [workspacePath]);
    await harness.remove({ cwd, args: workspacePath });
    assert.deepEqual(harness.observedSelectRequests, []);
    assert.deepEqual(harness.observedConfirmations, [
      {
        title: workspaceCommands.remove.confirmTitle,
        message: confirmationMessageTemplates.removeWorkspace(workspacePath),
      },
    ]);
    assert.deepEqual(harness.appendedSnapshots, [
      {
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [] },
      },
    ]);
  });
  it("does nothing when confirmation is declined", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "stored-workspace");
    const harness = createWorkspaceRemoveHarness({ confirmResult: false });
    await harness.restore(cwd, [workspacePath]);
    await harness.remove({ cwd, args: workspacePath });
    assert.equal(harness.observedConfirmations.length, 1);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.observedNotifications, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("does nothing when selection is cancelled", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "stored-workspace");
    const harness = createWorkspaceRemoveHarness();
    await harness.restore(cwd, [workspacePath]);
    await harness.remove({ cwd });
    assert.equal(harness.observedSelectRequests.length, 1);
    assert.deepEqual(harness.observedConfirmations, []);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.observedNotifications, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("warns instead of opening an empty selector", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceRemoveHarness();
    await harness.remove({ cwd });
    assert.deepEqual(harness.observedSelectRequests, []);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.noAdditionalWorkspacesToRemove(),
        type: "warning",
      },
    ]);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("does nothing without an argument when UI is unavailable", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceRemoveHarness();
    await harness.remove({ cwd, hasUI: false });
    assert.deepEqual(harness.observedSelectRequests, []);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("does not remove an exact path when confirmation UI is unavailable", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "stored-workspace");
    const harness = createWorkspaceRemoveHarness();
    await harness.restore(cwd, [workspacePath]);
    await harness.remove({ cwd, args: workspacePath, hasUI: false });
    assert.deepEqual(harness.observedConfirmations, []);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("warns when asked to remove the primary workspace", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceRemoveHarness();
    await harness.remove({ cwd, args: cwd });
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.primaryWorkspaceNotRemovable(cwd),
        type: "warning",
      },
    ]);
    assert.deepEqual(harness.observedConfirmations, []);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("warns when the exact path is not stored", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "unknown-workspace");
    const harness = createWorkspaceRemoveHarness();
    await harness.remove({ cwd, args: workspacePath });
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceNotFound(workspacePath),
        type: "warning",
      },
    ]);
    assert.deepEqual(harness.observedConfirmations, []);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
  });
  it("retains prior state when snapshot persistence fails", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const workspacePath = join(cwd, "stored-workspace");
    const appendError = new Error("session is read-only");
    const harness = createWorkspaceRemoveHarness({ appendError });
    await harness.restore(cwd, [workspacePath]);
    await harness.remove({ cwd, args: workspacePath });
    await harness.list(cwd);
    assert.deepEqual(harness.appendedSnapshots, []);
    assert.deepEqual(harness.lifecycleEvents, []);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: errorMessageTemplates.workspaceRemoveFailed(
          appendError.message,
        ),
        type: "warning",
      },
      {
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${workspacePath}`,
        type: "info",
      },
    ]);
  });
});
