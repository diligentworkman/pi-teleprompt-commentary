import type {
  CustomEntry,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import { workspaceEntryType } from "#/workspaces/index.ts";

type Notification = {
  message: Parameters<ExtensionUIContext["notify"]>[0];
  type: Parameters<ExtensionUIContext["notify"]>[1];
};

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-context-wiring-"));
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

function createWorkspaceContextHarness() {
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
          throw new Error(
            "Workspace context wiring must not create directories.",
          );
        },
        async createFileExclusively() {
          throw new Error("Workspace context wiring must not create files.");
        },
        async readFile() {
          throw new Error(
            "Workspace context wiring must not read config files.",
          );
        },
      },
      processRunner: {
        start() {
          throw new Error("Workspace context wiring must not start processes.");
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
          "Workspace context wiring must not read starter config.",
        );
      },
      async saveConfiguration() {
        throw new Error("Workspace context wiring must not save config.");
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
      await handlers[0]({ type: "session_start" }, createContext(cwd, true));
    },
    async beforeAgentStart({
      cwd,
      systemPrompt,
      hasUI = true,
    }: {
      cwd: string;
      systemPrompt: string;
      hasUI?: boolean;
    }) {
      const handlers = eventHandlers.get("before_agent_start");
      if (!handlers || handlers.length !== 1) {
        throw new Error("The harness requires one before-agent-start handler.");
      }

      return handlers[0](
        {
          type: "before_agent_start",
          prompt: "Review the workspaces.",
          systemPrompt,
          systemPromptOptions: {},
        },
        createContext(cwd, hasUI),
      );
    },
  };
}

describe("workspace context wiring", () => {
  it("rereads only additional-workspace sources before every agent run", async (testContext) => {
    const cwd = await createTemporaryDirectory(testContext);
    const additionalWorkspace = join(cwd, "additional-workspace");
    const instructionPath = join(additionalWorkspace, "AGENTS.md");
    const systemPromptAppendPath = join(
      additionalWorkspace,
      ".pi/APPEND_SYSTEM.md",
    );
    await mkdir(join(additionalWorkspace, ".pi"), { recursive: true });
    await Promise.all([
      writeFile(join(cwd, "AGENTS.md"), "Primary marker", "utf8"),
      writeFile(instructionPath, "Initial additional instructions", "utf8"),
      writeFile(systemPromptAppendPath, "Additional system guidance", "utf8"),
    ]);
    const harness = createWorkspaceContextHarness();
    await harness.restore({ cwd, additionalWorkspaces: [additionalWorkspace] });

    const firstResult = (await harness.beforeAgentStart({
      cwd,
      systemPrompt: "Base system prompt",
    })) as { systemPrompt: string };
    await writeFile(instructionPath, "Updated additional instructions", "utf8");
    const secondResult = (await harness.beforeAgentStart({
      cwd,
      systemPrompt: "Base system prompt",
    })) as { systemPrompt: string };
    assert.ok(firstResult.systemPrompt.startsWith("Base system prompt\n\n"));
    assert.match(firstResult.systemPrompt, /Initial additional instructions/);
    assert.doesNotMatch(firstResult.systemPrompt, /Primary marker/);
    assert.doesNotMatch(
      secondResult.systemPrompt,
      /Initial additional instructions/,
    );
    assert.match(secondResult.systemPrompt, /Updated additional instructions/);
    assert.ok(
      secondResult.systemPrompt.indexOf("Additional system guidance") <
        secondResult.systemPrompt.indexOf("Updated additional instructions"),
    );
    assert.deepEqual(harness.observedNotifications, []);
  });
  it("attributes unavailable primary and additional workspaces without UI", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const unavailablePrimary = join(directory, "unavailable-primary");
    const unavailableAdditional = join(directory, "unavailable-additional");
    const harness = createWorkspaceContextHarness();
    await harness.restore({
      cwd: unavailablePrimary,
      additionalWorkspaces: [unavailableAdditional],
    });
    const result = (await harness.beforeAgentStart({
      cwd: unavailablePrimary,
      systemPrompt: "Base system prompt",
      hasUI: false,
    })) as { systemPrompt: string };
    assert.ok(
      result.systemPrompt.includes(
        `<workspace role="primary" path="${unavailablePrimary}" availability="unavailable"`,
      ),
    );
    assert.ok(
      result.systemPrompt.includes(
        `<workspace role="additional" path="${unavailableAdditional}" availability="unavailable" reason="path does not exist">`,
      ),
    );
    assert.deepEqual(harness.observedNotifications, []);
  });
});
