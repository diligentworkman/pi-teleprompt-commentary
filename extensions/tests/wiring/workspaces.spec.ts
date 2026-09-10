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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { registerTelepromptCommentary } from "#/index.ts";
import type { ProcessCompletion } from "#/process/index.ts";
import {
  commands as workspaceCommands,
  confirmationMessageTemplates,
  errorMessageTemplates,
  infoMessageTemplates,
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
  data: { additionalWorkspaces: readonly string[] };
};

type ConfirmationRequest = {
  title: string;
  message: string;
};

type InputRequest = {
  title: string;
  placeholder?: string;
};

type SelectRequest = {
  title: string;
  options: string[];
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-workspace-wiring-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

function createWorkspaceBranch(snapshots: readonly string[][]) {
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
  selectResult,
  confirmResult = true,
  appendError,
  configurationSource = "",
  processCompletions,
  workspaceGroupId = "workspace-group-id",
  workspaceGroupIds,
}: {
  inputResult?: string;
  selectResult?: string;
  confirmResult?: boolean;
  appendError?: Error;
  configurationSource?: string;
  processCompletions?: Array<Promise<ProcessCompletion>>;
  workspaceGroupId?: string;
  workspaceGroupIds?: string[];
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<string, Array<(event: any, context: any) => unknown>>();
  const observedConfirmations: ConfirmationRequest[] = [];
  const observedNotifications: Notification[] = [];
  const observedInputRequests: InputRequest[] = [];
  const observedSelectRequests: SelectRequest[] = [];
  const appendedSnapshots: AppendedWorkspaceSnapshot[] = [];
  const lifecycleEvents: string[] = [];
  const processCommands: string[][] = [];
  let generatedGroupIdCount = 0;
  let activeBranch: SessionEntry[] = [];
  registerTelepromptCommentary({
    pi: {
      appendEntry(customType: string, data: { additionalWorkspaces: readonly string[] }) {
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
          throw new Error("Workspace listing must not read configuration files.");
        },
      },
      processRunner: {
        start({ command }) {
          const completion = processCompletions?.shift();
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
        throw new Error("Workspace listing must not load starter configuration.");
      },
      async saveConfiguration() {
        throw new Error("Workspace commands must not save configuration.");
      },
      createWorkspaceGroupId() {
        generatedGroupIdCount += 1;

        return workspaceGroupIds?.shift() ?? workspaceGroupId;
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
          throw new Error("Workspace restoration must read only the active branch.");
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
        async select(title: string, options: string[]) {
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
    processCommands,
    get generatedGroupIdCount() {
      return generatedGroupIdCount;
    },
    observedConfirmations,
    observedInputRequests,
    observedNotifications,
    observedSelectRequests,
    async restore({ event, branch, cwd }: {
      event: "session_start" | "session_tree";
      branch: SessionEntry[];
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
    async add({ cwd, args = "", hasUI = true }: {
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
    async remove({ cwd, args = "", hasUI = true }: {
      cwd: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(workspaceCommands.remove.name);
      if (!command) {
        throw new Error("The harness has no workspace-remove command.");
      }
      await command.handler(args, createContext(cwd, hasUI));
    },
    async open({ cwd, args = "", hasUI = true }: {
      cwd: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(workspaceCommands.open.name);
      if (!command) {
        throw new Error("The harness has no workspace-open command.");
      }
      await command.handler(args, createContext(cwd, hasUI));
    },
    async openAll({ cwd, args = "", hasUI = true }: {
      cwd: string;
      args?: string;
      hasUI?: boolean;
    }) {
      const command = commands.get(workspaceCommands.openAll.name);
      if (!command) {
        throw new Error("The harness has no workspaces-open command.");
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

describe("workspace wiring", () => {
  describe("workspace add command", () => {
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
      assert.deepEqual(harness.appendedSnapshots, [{
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [existingWorkspace, workspacePath] },
      }]);
      assert.deepEqual(harness.observedConfirmations, [{
        title: workspaceCommands.add.confirmTitle,
        message: confirmationMessageTemplates.addWorkspace(workspacePath),
      }]);
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
      assert.deepEqual(harness.observedInputRequests, [{
        title: workspaceCommands.add.inputTitle,
        placeholder: workspaceCommands.add.inputPlaceholder,
      }]);
      assert.deepEqual(harness.observedConfirmations, [{
        title: workspaceCommands.add.confirmTitle,
        message: confirmationMessageTemplates.addWorkspace(workspacePath),
      }]);
      assert.deepEqual(harness.appendedSnapshots, [{
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [workspacePath] },
      }]);
    });
    it("does nothing when addition confirmation is declined", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "declined-workspace");
      await mkdir(workspacePath);
      const harness = createWorkspaceWiringHarness({ confirmResult: false });
      await harness.add({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedConfirmations, [{
        title: workspaceCommands.add.confirmTitle,
        message: confirmationMessageTemplates.addWorkspace(workspacePath),
      }]);
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
      assert.deepEqual(harness.observedNotifications, [{
        message: infoMessageTemplates.workspaceAlreadyPresent(workspacePath),
        type: "info",
      }]);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("warns for a non-directory without persisting or reloading", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "file.txt");
      await writeFile(workspacePath, "not a directory", "utf8");
      const harness = createWorkspaceWiringHarness();
      await harness.add({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedNotifications, [{
        message: errorMessageTemplates.workspaceAddFailed(
          errorMessageTemplates.workspacePathNotDirectory(workspacePath),
        ),
        type: "warning",
      }]);
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
          message: errorMessageTemplates.workspaceAddFailed(appendError.message),
          type: "warning",
        },
        {
          message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${existingWorkspace}`,
          type: "info",
        },
      ]);
    });
  });
  describe("workspace remove command", () => {
    it("selects and removes one stored path without filesystem validation", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const staleWorkspace = join(cwd, "deleted-workspace");
      const retainedWorkspace = join(cwd, "retained-workspace");
      const harness = createWorkspaceWiringHarness({
        selectResult: staleWorkspace,
      });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[staleWorkspace, retainedWorkspace]]),
        cwd,
      });
      await harness.remove({ cwd });
      assert.deepEqual(harness.observedSelectRequests, [{
        title: workspaceCommands.remove.selectTitle,
        options: [staleWorkspace, retainedWorkspace],
      }]);
      assert.deepEqual(harness.appendedSnapshots, [{
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [retainedWorkspace] },
      }]);
      assert.deepEqual(harness.observedConfirmations, [{
        title: workspaceCommands.remove.confirmTitle,
        message: confirmationMessageTemplates.removeWorkspace(staleWorkspace),
      }]);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, [
        "snapshot-appended",
        "reload-started",
      ]);
    });
    it("accepts an exact argument and persists removal to an empty list", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
      await harness.remove({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedSelectRequests, []);
      assert.deepEqual(harness.observedConfirmations, [{
        title: workspaceCommands.remove.confirmTitle,
        message: confirmationMessageTemplates.removeWorkspace(workspacePath),
      }]);
      assert.deepEqual(harness.appendedSnapshots, [{
        customType: workspaceEntryType,
        data: { additionalWorkspaces: [] },
      }]);
    });
    it("does nothing when removal confirmation is declined", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      const harness = createWorkspaceWiringHarness({ confirmResult: false });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
      await harness.remove({ cwd, args: workspacePath });
      assert.equal(harness.observedConfirmations.length, 1);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does nothing when selection is cancelled", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
      await harness.remove({ cwd });
      assert.equal(harness.observedSelectRequests.length, 1);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.observedNotifications, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("warns instead of opening an empty selector", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.remove({ cwd });
      assert.deepEqual(harness.observedSelectRequests, []);
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.noAdditionalWorkspacesToRemove(),
        type: "warning",
      }]);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does nothing without an argument when UI is unavailable", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.remove({ cwd, hasUI: false });
      assert.deepEqual(harness.observedSelectRequests, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("does not remove an exact path when UI confirmation is unavailable", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
      await harness.remove({ cwd, args: workspacePath, hasUI: false });
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("warns when asked to remove the primary workspace", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.remove({ cwd, args: cwd });
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.primaryWorkspaceNotRemovable(cwd),
        type: "warning",
      }]);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("warns when the exact path is not stored", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "unknown-workspace");
      const harness = createWorkspaceWiringHarness();
      await harness.remove({ cwd, args: workspacePath });
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceNotFound(workspacePath),
        type: "warning",
      }]);
      assert.deepEqual(harness.observedConfirmations, []);
      assert.deepEqual(harness.appendedSnapshots, []);
      assert.deepEqual(harness.lifecycleEvents, []);
    });
    it("retains prior state when snapshot persistence fails", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const workspacePath = join(cwd, "stored-workspace");
      const appendError = new Error("session is read-only");
      const harness = createWorkspaceWiringHarness({ appendError });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[workspacePath]]),
        cwd,
      });
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
  describe("workspace opener commands", () => {
    const openerConfiguration = `
[[handlers.workspace_opener]]
action = ["earlier-opener"]

[[handlers.workspace_opener]]
action = [
  "workspace-opener",
  { var = "directory_path" },
  { var = "group_id", prepend = "--group=" }
]
`;
    const cleanCompletion: ProcessCompletion = {
      type: "exited",
      exitCode: 0,
      signal: null,
    };
    it("selects one session workspace and starts the last matching opener without waiting", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const additionalWorkspace = join(cwd, "additional-workspace");
      const pendingCompletion = new Promise<ProcessCompletion>(() => {});
      const harness = createWorkspaceWiringHarness({
        selectResult: additionalWorkspace,
        configurationSource: openerConfiguration,
        processCompletions: [pendingCompletion],
      });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[additionalWorkspace]]),
        cwd,
      });
      await harness.open({ cwd });
      assert.deepEqual(harness.observedSelectRequests, [{
        title: workspaceCommands.open.selectTitle,
        options: [cwd, additionalWorkspace],
      }]);
      assert.deepEqual(harness.processCommands, [[
        "workspace-opener",
        additionalWorkspace,
        "--group=workspace-group-id",
      ]]);
      assert.equal(harness.generatedGroupIdCount, 1);
      assert.deepEqual(harness.observedNotifications, []);
    });
    it("does nothing when workspace selection is cancelled", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.open({ cwd });
      assert.equal(harness.observedSelectRequests.length, 1);
      assert.deepEqual(harness.processCommands, []);
      assert.equal(harness.generatedGroupIdCount, 0);
      assert.deepEqual(harness.observedNotifications, []);
    });
    it("accepts an exact session workspace argument", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [Promise.resolve(cleanCompletion)],
      });
      await harness.open({ cwd, args: cwd });
      assert.deepEqual(harness.observedSelectRequests, []);
      assert.deepEqual(harness.processCommands, [[
        "workspace-opener",
        cwd,
        "--group=workspace-group-id",
      ]]);
    });
    it("opens an exact path without UI and suppresses UI notifications", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [Promise.resolve(cleanCompletion)],
      });
      await harness.open({ cwd, args: cwd, hasUI: false });
      assert.deepEqual(harness.processCommands, [[
        "workspace-opener",
        cwd,
        "--group=workspace-group-id",
      ]]);
      assert.deepEqual(harness.observedNotifications, []);
    });
    it("uses a distinct group ID for each separate invocation", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const firstGroupId = "first-workspace-group";
      const secondGroupId = "second-workspace-group";
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [
          Promise.resolve(cleanCompletion),
          Promise.resolve(cleanCompletion),
        ],
        workspaceGroupIds: [firstGroupId, secondGroupId],
      });
      await harness.open({ cwd, args: cwd });
      await harness.open({ cwd, args: cwd });
      assert.deepEqual(harness.processCommands, [
        ["workspace-opener", cwd, `--group=${firstGroupId}`],
        ["workspace-opener", cwd, `--group=${secondGroupId}`],
      ]);
      assert.equal(harness.generatedGroupIdCount, 2);
    });
    it("warns when an exact argument is not a session workspace", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const unknownWorkspace = join(cwd, "unknown-workspace");
      const harness = createWorkspaceWiringHarness();
      await harness.open({ cwd, args: unknownWorkspace });
      assert.deepEqual(harness.processCommands, []);
      assert.equal(harness.generatedGroupIdCount, 0);
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceNotFound(unknownWorkspace),
        type: "warning",
      }]);
    });
    it("warns when no opener rule matches", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.open({ cwd, args: cwd });
      assert.deepEqual(harness.processCommands, []);
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceOpenerNotConfigured(cwd),
        type: "warning",
      }]);
    });
    it("uses one group ID and continues after an opener spawn failure", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const additionalWorkspace = join(cwd, "additional-workspace");
      const spawnFailure: ProcessCompletion = {
        type: "spawn-failed",
        error: new Error("opener executable was missing"),
      };
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [
          Promise.resolve(spawnFailure),
          Promise.resolve(cleanCompletion),
        ],
      });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[additionalWorkspace]]),
        cwd,
      });
      await harness.openAll({ cwd });
      await nextEventLoopTurn();
      assert.deepEqual(harness.processCommands, [
        ["workspace-opener", cwd, "--group=workspace-group-id"],
        [
          "workspace-opener",
          additionalWorkspace,
          "--group=workspace-group-id",
        ],
      ]);
      assert.equal(harness.generatedGroupIdCount, 1);
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion: spawnFailure,
        }),
        type: "warning",
      }]);
    });
    it("warns when an opener exits with a nonzero code", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: 9,
        signal: null,
      };
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [Promise.resolve(completion)],
      });
      await harness.open({ cwd, args: cwd });
      await nextEventLoopTurn();
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion,
        }),
        type: "warning",
      }]);
    });
    it("warns when an opener exits after a signal", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const completion: ProcessCompletion = {
        type: "exited",
        exitCode: null,
        signal: "SIGTERM",
      };
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [Promise.resolve(completion)],
      });
      await harness.open({ cwd, args: cwd });
      await nextEventLoopTurn();
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion,
        }),
        type: "warning",
      }]);
    });
    it("skips an unavailable primary and still opens additional workspaces", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const unavailablePrimary = join(directory, "deleted-primary");
      const additionalWorkspace = join(directory, "additional-workspace");
      await mkdir(unavailablePrimary);
      await rm(unavailablePrimary, { recursive: true });
      const harness = createWorkspaceWiringHarness({
        configurationSource: openerConfiguration,
        processCompletions: [Promise.resolve(cleanCompletion)],
      });
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[additionalWorkspace]]),
        cwd: unavailablePrimary,
      });
      await harness.openAll({ cwd: unavailablePrimary });
      assert.deepEqual(harness.processCommands, [[
        "workspace-opener",
        additionalWorkspace,
        "--group=workspace-group-id",
      ]]);
      assert.equal(harness.observedNotifications.length, 1);
      assert.equal(harness.observedNotifications[0].type, "warning");
      assert.ok(
        harness.observedNotifications[0].message.startsWith(
          `Primary workspace "${unavailablePrimary}" is unavailable:`,
        ),
      );
    });
    it("warns when no workspace remains available to open", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const unavailablePrimary = join(directory, "deleted-primary");
      await mkdir(unavailablePrimary);
      await rm(unavailablePrimary, { recursive: true });
      const harness = createWorkspaceWiringHarness();
      await harness.openAll({ cwd: unavailablePrimary });
      assert.deepEqual(harness.processCommands, []);
      assert.equal(harness.generatedGroupIdCount, 0);
      assert.equal(harness.observedNotifications.length, 2);
      assert.equal(harness.observedNotifications[0].type, "warning");
      assert.ok(
        harness.observedNotifications[0].message.startsWith(
          `Primary workspace "${unavailablePrimary}" is unavailable:`,
        ),
      );
      assert.deepEqual(harness.observedNotifications[1], {
        message: warningMessageTemplates.noWorkspacesAvailableToOpen(),
        type: "warning",
      });
    });
    it("rejects arguments because workspaces-open is argument-free", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.openAll({ cwd, args: "unexpected" });
      assert.equal(harness.generatedGroupIdCount, 0);
      assert.deepEqual(harness.processCommands, []);
      assert.deepEqual(harness.observedNotifications, [{
        message: warningMessageTemplates.workspacesOpenDoesNotAcceptArguments(),
        type: "warning",
      }]);
    });
  });
  describe("workspace list command", () => {
    it("lists the primary workspace and an empty additional list after startup", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.restore({ event: "session_start", branch: [], cwd });
      await harness.list(cwd);
      assert.deepEqual(harness.observedNotifications, [{
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  None`,
        type: "info",
      }]);
    });
    it("lists the latest startup snapshot in its stored order", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const firstAdditional = join(cwd, "z-project");
      const secondAdditional = join(cwd, "a-project");
      const branch = createWorkspaceBranch([[], [firstAdditional, secondAdditional]]);
      const harness = createWorkspaceWiringHarness();
      await harness.restore({ event: "session_start", branch, cwd });
      await harness.list(cwd);
      assert.deepEqual(harness.observedNotifications, [{
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${firstAdditional}\n  ${secondAdditional}`,
        type: "info",
      }]);
    });
    it("replaces rather than merges additional workspaces after tree navigation", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const oldAdditional = join(cwd, "old-branch");
      const newAdditional = join(cwd, "new-branch");
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start", branch: createWorkspaceBranch([[oldAdditional]]), cwd,
      });
      await harness.restore({
        event: "session_tree", branch: createWorkspaceBranch([[newAdditional]]), cwd,
      });
      await harness.list(cwd);
      assert.deepEqual(harness.observedNotifications, [{
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${newAdditional}`,
        type: "info",
      }]);
    });
    it("clears previous additional workspaces when the new branch has no snapshot", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start", branch: createWorkspaceBranch([[join(cwd, "old")]]), cwd,
      });
      await harness.restore({ event: "session_tree", branch: [], cwd });
      await harness.list(cwd);
      assert.deepEqual(harness.observedNotifications, [{
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  None`,
        type: "info",
      }]);
    });
    it("warns and still lists additional workspaces when the primary is unavailable", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const unavailablePrimary = join(directory, "deleted-primary");
      const additionalWorkspace = join(directory, "additional-workspace");
      await mkdir(unavailablePrimary);
      await rm(unavailablePrimary, { recursive: true });
      let resolutionError: Error;
      try {
        await realpath(unavailablePrimary);
        throw new Error("The removed primary unexpectedly remained resolvable.");
      } catch (error) {
        resolutionError = error instanceof Error ? error : new Error(String(error));
      }
      const harness = createWorkspaceWiringHarness();
      await harness.restore({
        event: "session_start",
        branch: createWorkspaceBranch([[additionalWorkspace]]),
        cwd: unavailablePrimary,
      });
      await harness.list(unavailablePrimary);
      assert.deepEqual(harness.observedNotifications, [
        {
          message: warningMessageTemplates.primaryWorkspaceUnavailable({
            workspacePath: unavailablePrimary,
            errorMessage: resolutionError.message,
          }),
          type: "warning",
        },
        {
          message: `Primary workspace:\n  ${unavailablePrimary} (unavailable)\n\nAdditional workspaces:\n  ${additionalWorkspace}`,
          type: "info",
        },
      ]);
    });
    it("derives the canonical primary from the current cwd on every invocation", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const firstPrimary = join(directory, "first");
      const secondPrimary = join(directory, "second");
      const firstAlias = join(directory, "first-alias");
      await mkdir(firstPrimary);
      await mkdir(secondPrimary);
      await symlink(firstPrimary, firstAlias, process.platform === "win32" ? "junction" : "dir");
      const harness = createWorkspaceWiringHarness();
      await harness.restore({ event: "session_start", branch: [], cwd: firstAlias });
      await harness.list(firstAlias);
      await harness.list(secondPrimary);
      assert.deepEqual(harness.observedNotifications, [
        {
          message: `Primary workspace:\n  ${firstPrimary}\n\nAdditional workspaces:\n  None`,
          type: "info",
        },
        {
          message: `Primary workspace:\n  ${secondPrimary}\n\nAdditional workspaces:\n  None`,
          type: "info",
        },
      ]);
    });
  });
});
