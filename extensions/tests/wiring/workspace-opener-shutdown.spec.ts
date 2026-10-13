import { registerTelepromptCommentary } from "#/index.ts";
import { commands as workspaceCommands, workspaceEntryType } from "#/workspaces/index.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

async function createRoot(testContext: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-opener-shutdown-")));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return root;
}

function createHarness({ cwd, additionalWorkspaces = [], selection }: {
  cwd: string;
  additionalWorkspaces?: Array<string>;
  selection?: Promise<string | undefined>;
}) {
  const events = new Map<string, (event: any, context: any) => unknown>();
  const commands = new Map<string, { handler(args: string, context: any): unknown }>();
  const launched: Array<Array<string>> = [];
  const notifications: Array<string> = [];
  const selecting = createDeferred<void>();
  let readSource = async () => "";
  let configurationReads = 0;
  let cleanupCalls = 0;
  let groupIds = 0;
  const context = {
    cwd,
    hasUI: true,
    sessionManager: {
      getBranch() {
        return [{
          type: "custom", customType: workspaceEntryType, data: { additionalWorkspaces },
          id: "workspace-state", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
        }];
      },
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async select() {
        selecting.resolve();

        return selection;
      },
    },
  };
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        events.set(name, handler);
      },
      registerCommand(name: string, command: { handler(args: string, context: any): unknown }) {
        commands.set(name, command);
      },
    } as any,
    dependencies: {
      configFilePath: join(cwd, "unused-config.toml"),
      fileSystem: {
        async createDirectory() {
          throw new Error("Opener commands must not create configuration directories.");
        },
        async createFileExclusively() {
          throw new Error("Opener commands must not create configuration files.");
        },
        async readFile() {
          throw new Error("Opener commands use the injected configuration reader.");
        },
      },
      processRunner: {
        start({ command }) {
          launched.push(command);

          return {
            completion: Promise.resolve({ type: "exited", exitCode: 0, signal: null }),
            async terminate() {
              return { type: "already-exited" };
            },
          };
        },
        async cleanup() {
          cleanupCalls += 1;

          return [];
        },
      },
      async readConfigurationFile() {
        configurationReads += 1;

        return readSource();
      },
      async readStarterConfigurationSource() {
        throw new Error("Opener commands must not load starter configuration.");
      },
      async saveConfiguration() {
        throw new Error("Opener commands must not save configuration.");
      },
      createWorkspaceGroupId() {
        groupIds += 1;

        return "workspace-group";
      },
    },
  });

  return {
    launched,
    notifications,
    selecting: selecting.promise,
    get configurationReads() {
      return configurationReads;
    },
    get cleanupCalls() {
      return cleanupCalls;
    },
    get groupIds() {
      return groupIds;
    },
    setReader(reader: () => Promise<string>) {
      readSource = reader;
    },
    async restore() {
      await events.get("session_start")?.({}, context);
    },
    async shutdown() {
      await events.get("session_shutdown")?.({}, context);
    },
    async open({ name, args }: { name: string; args: string }) {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(`Missing registered command: ${name}`);
      }
      await command.handler(args, context);
    },
  };
}

describe("workspace opener shutdown wiring", () => {
  const configuration = '[[handlers.workspace_opener]]\naction = ["opener", { var = "directory_path" }]';
  for (const kind of ["single", "group"] as const) {
    const name = kind === "single" ? workspaceCommands.open.name : workspaceCommands.openAll.name;
    it(`does not launch ${kind} openers after shutdown completes during configuration loading`, async (testContext) => {
      const cwd = await createRoot(testContext);
      const additionalWorkspace = join(cwd, "additional");
      await mkdir(additionalWorkspace);
      const runtime = createHarness({ cwd, additionalWorkspaces: [additionalWorkspace] });
      await runtime.restore();
      const resolving = createDeferred<void>();
      const source = createDeferred<string>();
      runtime.setReader(() => {
        resolving.resolve();

        return source.promise;
      });
      const opening = runtime.open({ name, args: kind === "single" ? cwd : "" });
      await resolving.promise;
      await runtime.shutdown();
      source.resolve(configuration);
      await opening;
      assert.equal(runtime.cleanupCalls, 1);
      assert.deepEqual(runtime.launched, []);
      assert.deepEqual(runtime.notifications, []);
      assert.equal(runtime.configurationReads, kind === "single" ? 2 : 3);
    });
    it(`does not admit a new ${kind} opener command after shutdown`, async (testContext) => {
      const cwd = await createRoot(testContext);
      const runtime = createHarness({ cwd });
      await runtime.restore();
      await runtime.shutdown();
      await runtime.open({ name, args: kind === "single" ? cwd : "" });
      assert.equal(runtime.configurationReads, 1);
      assert.equal(runtime.groupIds, 0);
      assert.deepEqual(runtime.launched, []);
      assert.deepEqual(runtime.notifications, []);
    });
  }
  it("does not resolve or launch an opener when workspace selection returns after shutdown", async (testContext) => {
    const cwd = await createRoot(testContext);
    const selection = createDeferred<string | undefined>();
    const runtime = createHarness({ cwd, selection: selection.promise });
    await runtime.restore();
    const opening = runtime.open({ name: workspaceCommands.open.name, args: "" });
    await runtime.selecting;
    await runtime.shutdown();
    selection.resolve(cwd);
    await opening;
    assert.equal(runtime.configurationReads, 1);
    assert.equal(runtime.groupIds, 0);
    assert.deepEqual(runtime.launched, []);
    assert.deepEqual(runtime.notifications, []);
  });
});
