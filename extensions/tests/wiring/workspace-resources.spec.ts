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
import { registerTelepromptCommentary } from "#/index.ts";
import { warningMessageTemplates } from "#/workspace-resources/messages.ts";
import { workspaceEntryType } from "#/workspaces/index.ts";

type Notification = {
  message: Parameters<ExtensionUIContext["notify"]>[0];
  type: Parameters<ExtensionUIContext["notify"]>[1];
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "teleprompt-resource-wiring-"),
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

function createWorkspaceResourceHarness() {
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
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: "/config/teleprompt-commentary/config.toml",
      fileSystem: {
        async createDirectory() {
          throw new Error("Resource wiring must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Resource wiring must not create files.");
        },
        async readFile() {
          throw new Error("Resource wiring must not read config files.");
        },
      },
      processRunner: {
        start() {
          throw new Error("Resource wiring must not start processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error("Resource wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Resource wiring must not save config.");
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
      cwd,
      additionalWorkspaces,
    }: {
      event: "session_start" | "session_tree";
      cwd: string;
      additionalWorkspaces: Array<string>;
    }) {
      activeBranch = createWorkspaceBranch(additionalWorkspaces);
      const handlers = eventHandlers.get(event);
      if (!handlers || handlers.length !== 1) {
        throw new Error(`The harness requires one ${event} handler.`);
      }
      await handlers[0]({ type: event }, createContext(cwd, true));
    },
    async discoverResources({
      cwd,
      reason = "startup",
      hasUI = true,
    }: {
      cwd: string;
      reason?: "startup" | "reload";
      hasUI?: boolean;
    }) {
      const handlers = eventHandlers.get("resources_discover");
      if (!handlers || handlers.length !== 1) {
        throw new Error("The harness requires one resources-discover handler.");
      }
      return handlers[0](
        { type: "resources_discover", cwd, reason },
        createContext(cwd, hasUI),
      );
    },
  };
}

describe("workspace resource wiring", () => {
  it("contributes additional-workspace skills and prompts after restoration", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const firstWorkspace = join(cwd, "first-additional");
    const secondWorkspace = join(cwd, "second-additional");
    const firstPiSkills = join(firstWorkspace, ".pi/skills");
    const firstAgentSkills = join(firstWorkspace, ".agents/skills");
    const firstPrompts = join(firstWorkspace, ".pi/prompts");
    const secondPiSkills = join(secondWorkspace, ".pi/skills");
    await Promise.all([
      mkdir(firstPiSkills, { recursive: true }),
      mkdir(firstAgentSkills, { recursive: true }),
      mkdir(firstPrompts, { recursive: true }),
      mkdir(secondPiSkills, { recursive: true }),
    ]);
    const harness = createWorkspaceResourceHarness();
    await harness.restore({
      event: "session_start",
      cwd,
      additionalWorkspaces: [firstWorkspace, secondWorkspace],
    });
    assert.deepEqual(await harness.discoverResources({ cwd }), {
      skillPaths: [firstPiSkills, firstAgentSkills, secondPiSkills],
      promptPaths: [firstPrompts],
    });
    assert.deepEqual(harness.observedNotifications, []);
  });
  it("uses active tree state on reload and warns only with UI", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const staleWorkspace = join(cwd, "stale-additional");
    const unavailableWorkspace = join(cwd, "unavailable-additional");
    const activeWorkspace = join(cwd, "active-additional");
    const activePrompts = join(activeWorkspace, ".pi/prompts");
    await mkdir(activePrompts, { recursive: true });
    const harness = createWorkspaceResourceHarness();
    await harness.restore({
      event: "session_start",
      cwd,
      additionalWorkspaces: [staleWorkspace],
    });
    await harness.restore({
      event: "session_tree",
      cwd,
      additionalWorkspaces: [activeWorkspace, unavailableWorkspace],
    });
    assert.deepEqual(
      await harness.discoverResources({ cwd, reason: "reload" }),
      { skillPaths: [], promptPaths: [activePrompts] },
    );
    assert.deepEqual(harness.observedNotifications, [
      {
        message: warningMessageTemplates.additionalWorkspaceUnavailable({
          workspacePath: unavailableWorkspace,
          reason: "path does not exist",
        }),
        type: "warning",
      },
    ]);
    await harness.discoverResources({ cwd, reason: "reload", hasUI: false });
    assert.equal(harness.observedNotifications.length, 1);
  });
});
