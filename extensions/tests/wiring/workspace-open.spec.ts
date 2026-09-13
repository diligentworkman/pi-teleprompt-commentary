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
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { registerTelepromptCommentary } from "#/index.ts";
import type { ProcessCompletion } from "#/process/index.ts";
import {
  commands as workspaceCommands,
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

type SelectRequest = {
  title: string;
  options: Array<string>;
};

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

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-open-wiring-"));
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

function createWorkspaceOpenHarness({
  selectResult,
  configurationSource = "",
  processCompletions,
  workspaceGroupIds = ["workspace-group-id"],
}: {
  selectResult?: string;
  configurationSource?: string;
  processCompletions?: Array<Promise<ProcessCompletion>>;
  workspaceGroupIds?: Array<string>;
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const observedNotifications: Array<Notification> = [];
  const observedSelectRequests: Array<SelectRequest> = [];
  const processCommands: Array<Array<string>> = [];
  let activeBranch: Array<SessionEntry> = [];
  let generatedGroupIdCount = 0;
  registerTelepromptCommentary({
    pi: {
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
          throw new Error("Workspace-open wiring must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Workspace-open wiring must not create files.");
        },
        async readFile() {
          throw new Error("Workspace-open wiring must not read config files.");
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
        throw new Error("Workspace-open wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Workspace-open wiring must not save config.");
      },
      createWorkspaceGroupId() {
        generatedGroupIdCount += 1;
        const groupId = workspaceGroupIds.shift();
        if (groupId === undefined) {
          throw new Error("The harness has no remaining workspace group ID.");
        }

        return groupId;
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
        notify(message: string, type: Notification["type"]) {
          observedNotifications.push({ message, type });
        },
        async select(title: string, options: Array<string>) {
          observedSelectRequests.push({ title, options });

          return selectResult;
        },
      },
    };
  }

  return {
    processCommands,
    get generatedGroupIdCount() {
      return generatedGroupIdCount;
    },
    observedNotifications,
    observedSelectRequests,
    async restore({
      cwd,
      additionalWorkspaces,
    }: {
      cwd: string;
      additionalWorkspaces: Array<string>;
    }) {
      activeBranch = createWorkspaceBranch(additionalWorkspaces);
      const handlers = eventHandlers.get("session_start");
      if (!handlers || handlers.length !== 1) {
        throw new Error("The harness requires one session-start handler.");
      }
      await handlers[0]({ type: "session_start" }, createContext(cwd));
    },
    async open({
      cwd,
      args = "",
      hasUI = true,
    }: {
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
  };
}

describe("workspace-open wiring", () => {
  it("selects one workspace and starts the last matching opener without waiting", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const additionalWorkspace = join(cwd, "additional-workspace");
    const harness = createWorkspaceOpenHarness({
      selectResult: additionalWorkspace,
      configurationSource: openerConfiguration,
      processCompletions: [new Promise<ProcessCompletion>(() => {})],
    });
    await harness.restore({ cwd, additionalWorkspaces: [additionalWorkspace] });
    await harness.open({ cwd });
    assert.deepEqual(harness.observedSelectRequests, [
      {
        title: workspaceCommands.open.selectTitle,
        options: [cwd, additionalWorkspace],
      },
    ]);
    assert.deepEqual(harness.processCommands, [
      ["workspace-opener", additionalWorkspace, "--group=workspace-group-id"],
    ]);
    assert.equal(harness.generatedGroupIdCount, 1);
    assert.deepEqual(harness.observedNotifications, []);
  });
  it("does nothing when workspace selection is cancelled", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceOpenHarness();
    await harness.open({ cwd });
    assert.equal(harness.observedSelectRequests.length, 1);
    assert.deepEqual(harness.processCommands, []);
    assert.equal(harness.generatedGroupIdCount, 0);
    assert.deepEqual(harness.observedNotifications, []);
  });
  it("accepts an exact session workspace argument", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [Promise.resolve(cleanCompletion)],
    });
    await harness.open({ cwd, args: cwd });
    assert.deepEqual(harness.observedSelectRequests, []);
    assert.deepEqual(harness.processCommands, [
      ["workspace-opener", cwd, "--group=workspace-group-id"],
    ]);
  });
  it("opens an exact path without UI and suppresses notifications", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [Promise.resolve(cleanCompletion)],
    });
    await harness.open({ cwd, args: cwd, hasUI: false });
    assert.deepEqual(harness.processCommands, [
      ["workspace-opener", cwd, "--group=workspace-group-id"],
    ]);
    assert.deepEqual(harness.observedNotifications, []);
  });
  it("uses a distinct group ID for each invocation", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const firstGroupId = "first-workspace-group";
    const secondGroupId = "second-workspace-group";
    const harness = createWorkspaceOpenHarness({
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
    const harness = createWorkspaceOpenHarness();
    await harness.open({ cwd, args: unknownWorkspace });
    assert.deepEqual(harness.processCommands, []);
    assert.equal(harness.generatedGroupIdCount, 0);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceNotFound(unknownWorkspace),
        type: "warning",
      },
    ]);
  });
  it("warns when no opener rule matches", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceOpenHarness();
    await harness.open({ cwd, args: cwd });
    assert.deepEqual(harness.processCommands, []);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceOpenerNotConfigured(cwd),
        type: "warning",
      },
    ]);
  });
  it("warns when an opener exits with a nonzero code", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const completion: ProcessCompletion = {
      type: "exited",
      exitCode: 9,
      signal: null,
    };
    const harness = createWorkspaceOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [Promise.resolve(completion)],
    });
    await harness.open({ cwd, args: cwd });
    await nextEventLoopTurn();
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion,
        }),
        type: "warning",
      },
    ]);
  });
  it("warns when an opener exits after a signal", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const completion: ProcessCompletion = {
      type: "exited",
      exitCode: null,
      signal: "SIGTERM",
    };
    const harness = createWorkspaceOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [Promise.resolve(completion)],
    });
    await harness.open({ cwd, args: cwd });
    await nextEventLoopTurn();
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion,
        }),
        type: "warning",
      },
    ]);
  });
});
