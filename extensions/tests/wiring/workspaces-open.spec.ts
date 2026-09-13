import type {
  CustomEntry,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(
    join(tmpdir(), "teleprompt-open-all-wiring-"),
  );
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

function createWorkspacesOpenHarness({
  configurationSource = "",
  processCompletions,
  workspaceGroupId = "workspace-group-id",
}: {
  configurationSource?: string;
  processCompletions?: Array<Promise<ProcessCompletion>>;
  workspaceGroupId?: string;
} = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const observedNotifications: Array<Notification> = [];
  const processCommands: Array<Array<string>> = [];
  let generatedGroupIdCount = 0;
  let activeBranch: Array<SessionEntry> = [];
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
          throw new Error(
            "Workspaces-open wiring must not create directories.",
          );
        },
        async createFileExclusively() {
          throw new Error("Workspaces-open wiring must not create files.");
        },
        async readFile() {
          throw new Error("Workspaces-open wiring must not read config files.");
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
        throw new Error("Workspaces-open wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Workspaces-open wiring must not save config.");
      },
      createWorkspaceGroupId() {
        generatedGroupIdCount += 1;
        return workspaceGroupId;
      },
    },
  });
  function createContext(cwd: string) {
    return {
      cwd,
      hasUI: true,
      sessionManager: {
        getBranch() {
          return activeBranch;
        },
      },
      ui: {
        notify(message: string, type: Notification["type"]) {
          observedNotifications.push({ message, type });
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
    async openAll({ cwd, args = "" }: { cwd: string; args?: string }) {
      const command = commands.get(workspaceCommands.openAll.name);
      if (!command) {
        throw new Error("The harness has no workspaces-open command.");
      }
      await command.handler(args, createContext(cwd));
    },
  };
}

describe("workspaces-open wiring", () => {
  it("uses one group ID and continues after an opener spawn failure", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const additionalWorkspace = join(cwd, "additional-workspace");
    const spawnFailure: ProcessCompletion = {
      type: "spawn-failed",
      error: new Error("opener executable was missing"),
    };
    const harness = createWorkspacesOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [
        Promise.resolve(spawnFailure),
        Promise.resolve(cleanCompletion),
      ],
    });
    await harness.restore({ cwd, additionalWorkspaces: [additionalWorkspace] });
    await harness.openAll({ cwd });
    await nextEventLoopTurn();
    assert.deepEqual(harness.processCommands, [
      ["workspace-opener", cwd, "--group=workspace-group-id"],
      ["workspace-opener", additionalWorkspace, "--group=workspace-group-id"],
    ]);
    assert.equal(harness.generatedGroupIdCount, 1);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspaceOpenerDidNotExitCleanly({
          workspacePath: cwd,
          completion: spawnFailure,
        }),
        type: "warning",
      },
    ]);
  });
  it("skips an unavailable primary and opens additional workspaces", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const unavailablePrimary = join(directory, "deleted-primary");
    const additionalWorkspace = join(directory, "additional-workspace");
    await mkdir(unavailablePrimary);
    await rm(unavailablePrimary, { recursive: true });
    const harness = createWorkspacesOpenHarness({
      configurationSource: openerConfiguration,
      processCompletions: [Promise.resolve(cleanCompletion)],
    });
    await harness.restore({
      cwd: unavailablePrimary,
      additionalWorkspaces: [additionalWorkspace],
    });
    await harness.openAll({ cwd: unavailablePrimary });
    assert.deepEqual(harness.processCommands, [
      ["workspace-opener", additionalWorkspace, "--group=workspace-group-id"],
    ]);
    assert.equal(harness.observedNotifications.length, 1);
    assert.equal(harness.observedNotifications[0].type, "warning");
    assert.ok(
      harness.observedNotifications[0].message.startsWith(
        `Primary workspace "${unavailablePrimary}" is unavailable:`,
      ),
    );
  });
  it("warns when no workspace remains available", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const unavailablePrimary = join(directory, "deleted-primary");
    await mkdir(unavailablePrimary);
    await rm(unavailablePrimary, { recursive: true });
    const harness = createWorkspacesOpenHarness();
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
  it("rejects arguments", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspacesOpenHarness();
    await harness.openAll({ cwd, args: "unexpected" });
    assert.equal(harness.generatedGroupIdCount, 0);
    assert.deepEqual(harness.processCommands, []);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.workspacesOpenDoesNotAcceptArguments(),
        type: "warning",
      },
    ]);
  });
});
