import type {
  CustomEntry,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt, getErrorMessage } from "#/errors/index.ts";
import { registerTelepromptCommentary } from "#/index.ts";
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

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-list-wiring-"));
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

function createWorkspaceListHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const observedNotifications: Array<Notification> = [];
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
          throw new Error("Workspace list wiring must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Workspace list wiring must not create files.");
        },
        async readFile() {
          throw new Error("Workspace list wiring must not read config files.");
        },
      },
      processRunner: {
        start() {
          throw new Error("Workspace list wiring must not start processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error("Workspace list wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Workspace list wiring must not save config.");
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
      if (!handlers || handlers.length !== 1) {
        throw new Error(`The harness requires one ${event} handler.`);
      }
      await handlers[0]({ type: event }, createContext(cwd));
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

describe("workspace list wiring", () => {
  it("lists the primary workspace and an empty additional list", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceListHarness();
    await harness.restore({ event: "session_start", branch: [], cwd });
    await harness.list(cwd);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  None`,
        type: "info",
      },
    ]);
  });
  it("lists the latest startup snapshot in stored order", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const firstAdditional = join(cwd, "z-project");
    const secondAdditional = join(cwd, "a-project");
    const harness = createWorkspaceListHarness();
    await harness.restore({
      event: "session_start",
      branch: createWorkspaceBranch([[], [firstAdditional, secondAdditional]]),
      cwd,
    });
    await harness.list(cwd);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${firstAdditional}\n  ${secondAdditional}`,
        type: "info",
      },
    ]);
  });
  it("replaces additional workspaces after tree navigation", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const oldAdditional = join(cwd, "old-branch");
    const newAdditional = join(cwd, "new-branch");
    const harness = createWorkspaceListHarness();
    await harness.restore({
      event: "session_start",
      branch: createWorkspaceBranch([[oldAdditional]]),
      cwd,
    });
    await harness.restore({
      event: "session_tree",
      branch: createWorkspaceBranch([[newAdditional]]),
      cwd,
    });
    await harness.list(cwd);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${newAdditional}`,
        type: "info",
      },
    ]);
  });
  it("clears previous workspaces when the new branch has no snapshot", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const harness = createWorkspaceListHarness();
    await harness.restore({
      event: "session_start",
      branch: createWorkspaceBranch([[join(cwd, "old")]]),
      cwd,
    });
    await harness.restore({ event: "session_tree", branch: [], cwd });
    await harness.list(cwd);
    assert.deepEqual(harness.observedNotifications, [
      {
        message: `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  None`,
        type: "info",
      },
    ]);
  });
  it("warns and lists additional workspaces when primary is unavailable", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const unavailablePrimary = join(directory, "deleted-primary");
    const additionalWorkspace = join(directory, "additional-workspace");
    await mkdir(unavailablePrimary);
    await rm(unavailablePrimary, { recursive: true });
    const resolution = await attempt(() => realpath(unavailablePrimary));
    assert.equal(resolution.success, false);
    if (resolution.success) {
      assert.fail("Expected removed primary resolution to fail");
    }
    const harness = createWorkspaceListHarness();
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
          errorMessage: getErrorMessage(resolution.error),
        }),
        type: "warning",
      },
      {
        message: `Primary workspace:\n  ${unavailablePrimary} (unavailable)\n\nAdditional workspaces:\n  ${additionalWorkspace}`,
        type: "info",
      },
    ]);
  });
  it("derives the canonical primary from current cwd every time", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const firstPrimary = join(directory, "first");
    const secondPrimary = join(directory, "second");
    const firstAlias = join(directory, "first-alias");
    await mkdir(firstPrimary);
    await mkdir(secondPrimary);
    await symlink(
      firstPrimary,
      firstAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const harness = createWorkspaceListHarness();
    await harness.restore({
      event: "session_start",
      branch: [],
      cwd: firstAlias,
    });
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
