import type {
  CustomEntry,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import {
  commands as workspaceCommands,
  confirmationMessageTemplates,
  errorMessageTemplates,
  infoMessageTemplates,
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

type ConfirmationRequest = {
  title: string;
  message: string;
};

type InputRequest = {
  title: string;
  placeholder?: string;
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "teleprompt-workspace-add-wiring-"),
  );
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

function createWorkspaceBranch(snapshots: ReadonlyArray<Array<string>>) {
  return snapshots.map((additionalWorkspaces, index) => {
    return {
      type: "custom",
      customType: workspaceEntryType,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { additionalWorkspaces },
    } satisfies CustomEntry;
  });
}

function createWorkspaceWiringHarness({
  inputResult,
  confirmResult = true,
  appendError,
}: {
  inputResult?: string;
  confirmResult?: boolean;
  appendError?: Error;
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const observedConfirmations: Array<ConfirmationRequest> = [];
  const observedNotifications: Array<Notification> = [];
  const observedInputRequests: Array<InputRequest> = [];
  const appendedSnapshots: Array<AppendedWorkspaceSnapshot> = [];
  const lifecycleEvents: Array<string> = [];
  let activeBranch: Array<SessionEntry> = [];
  registerTelepromptCommentary({
    pi: {
      appendEntry(
        customType: string,
        data: { additionalWorkspaces: ReadonlyArray<string> },
      ) {
        if (appendError !== undefined) {
          throw appendError;
        }
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
          throw new Error("Workspace listing must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Workspace listing must not create files.");
        },
        async readFile() {
          throw new Error(
            "Workspace listing must not read configuration files.",
          );
        },
      },
      processRunner: {
        start() {
          throw new Error("Workspace mutation wiring must not start processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error(
          "Workspace listing must not load starter configuration.",
        );
      },
      async saveConfiguration() {
        throw new Error("Workspace commands must not save configuration.");
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
        getEntries() {
          throw new Error(
            "Workspace restoration must read only the active branch.",
          );
        },
      },
      ui: {
        async confirm(title: string, message: string) {
          observedConfirmations.push({ title, message });

          return confirmResult;
        },
        async input(title: string, placeholder?: string) {
          observedInputRequests.push({ title, placeholder });

          return inputResult;
        },
        notify(message: string, type: Notification["type"]) {
          observedNotifications.push({ message, type });
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
    observedInputRequests,
    observedNotifications,
    async restore({
      event,
      branch,
      cwd,
    }: {
      event: "session_start" | "session_tree";
      branch: Array<SessionEntry>;
      cwd: string;
    }) {
      activeBranch = branch;
      const handlers = eventHandlers.get(event);
      if (!handlers) {
        throw new Error(`The harness has no handlers for "${event}".`);
      }
      for (const handler of handlers) {
        await handler({ type: event }, createContext(cwd));
      }
    },
    async add({
      cwd,
      args = "",
      hasUI = true,
    }: {
      cwd: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(workspaceCommands.add.name);
      if (!command) {
        throw new Error("The harness has no workspace-add command.");
      }
      await command.handler(args, createContext(cwd, hasUI));
    },
    async list(cwd: string) {
      const command = commands.get(workspaceCommands.list.name);
      if (!command) {
        throw new Error("The harness has no workspace-list command.");
      }
      await command.handler("", createContext(cwd));
    },
  };
}

describe("workspace-add wiring", () => {
    it("appends the full updated snapshot before reloading", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "new-workspace");
      const existingWorkspace = join(cwd, "existing-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[existingWorkspace]]),
        cwd,
      });
      await harness.add({ cwd, args: "new-workspace" });
      assert.deepEqual(harness.appendedSnapshots, [
        {
          customType: workspaceEntryType,
          data: { additionalWorkspaces: [existingWorkspace, workspacePath] },
        },
      ]);
      assert.deepEqual(harness.observedConfirmations, [
        {
          title: workspaceCommands.add.confirmTitle,
          message: confirmationMessageTemplates.addWorkspace(workspacePath),
        },
      ]);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, [
        "snapshot-appended",
        "reload-started",
      ]);
    });
    it("prompts for a path when no argument is provided", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "prompted-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness({
        inputResult: workspacePath,
      });
      await harness.add({ cwd });
      assert.deepEqual(harness.observedInputRequests, [
        {
          title: workspaceCommands.add.inputTitle,
          placeholder: workspaceCommands.add.inputPlaceholder,
        },
      ]);
      assert.deepEqual(harness.observedConfirmations, [
        {
          title: workspaceCommands.add.confirmTitle,
          message: confirmationMessageTemplates.addWorkspace(workspacePath),
        },
      ]);
      assert.deepEqual(harness.appendedSnapshots, [
        {
          customType: workspaceEntryType,
          data: { additionalWorkspaces: [workspacePath] },
        },
      ]);
    });
    it("does nothing when addition confirmation is declined", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "declined-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness({ confirmResult: false });
      await harness.add({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedConfirmations, [
        {
          title: workspaceCommands.add.confirmTitle,
          message: confirmationMessageTemplates.addWorkspace(workspacePath),
        },
      ]);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does nothing when path input is cancelled", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.add({ cwd });
      assert.equal(harness.observedInputRequests.length, 1);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does nothing without an argument when UI is unavailable", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.add({ cwd, hasUI: false });
      assert.deepEqual(harness.observedInputRequests, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does not add an exact path when UI confirmation is unavailable", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness();
      await harness.add({ cwd, args: workspacePath, hasUI: false });
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("reports an existing workspace without persisting or reloading", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "existing-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
      await harness.add({ cwd, args: workspacePath });
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.observedNotifications, [
        {
          message: infoMessageTemplates.workspaceAlreadyPresent(workspacePath),
          type: "info",
        },
      ]);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("warns for a non-directory without persisting or reloading", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "file.txt");
      await writeFile(workspacePath, "not a directory", "utf8");
      const harness = createWorkspaceWiringHarness();
      await harness.add({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedNotifications, [
        {
          message: errorMessageTemplates.workspaceAddFailed(
            errorMessageTemplates.workspacePathNotDirectory(workspacePath),
          ),
          type: "warning",
        },
      ]);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("retains prior state when snapshot persistence fails", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "new-workspace");
      const existingWorkspace = join(cwd, "existing-workspace");
      const appendError = new Error("session is read-only");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness({ appendError });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[existingWorkspace]]),
        cwd,
      });
      await harness.add({ cwd, args: workspacePath });
      await harness.list(cwd);
      assert.equal(harness.observedConfirmations.length, 1);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
      assert.deepEqual(harness.observedNotifications, [
        {
          message: errorMessageTemplates.workspaceAddFailed(
            appendError.message,
          ),
          type: "warning",
        },
        {
          message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${existingWorkspace}`,
          type: "info",
        },
      ]);
  });
});
