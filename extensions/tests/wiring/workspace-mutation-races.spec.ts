import { registerTelepromptCommentary } from "#/index.ts";
import { commands as workspaceCommands, warningMessageTemplates, workspaceEntryType } from "#/workspaces/index.ts";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
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

async function createPaths(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-workspace-revisions-")));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "primary");
  const target = join(root, "target");
  const other = join(root, "other");
  await Promise.all([mkdir(cwd), mkdir(target), mkdir(other)]);

  return { cwd, target, other };
}

function createHarness(cwd: string) {
  const events = new Map<string, (event: any, context: any) => unknown>();
  const commands = new Map<string, { handler(args: string, context: any): unknown }>();
  const snapshots: Array<{ additionalWorkspaces: Array<string> }> = [];
  const notifications: Array<string> = [];
  let activeBranch: Array<SessionEntry> = [];
  let reloads = 0;
  let confirmations = 0;
  function createContext({ decision = true, onConfirm, choice, onChoice }: {
    decision?: boolean | Promise<boolean>;
    onConfirm?: () => void;
    choice?: Promise<string | undefined>;
    onChoice?: () => void;
  } = {}) {
    return {
      cwd,
      hasUI: true,
      sessionManager: {
        getBranch() {
          return activeBranch;
        },
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        async confirm() {
          confirmations += 1;
          onConfirm?.();

          return decision;
        },
        async input() {
          onChoice?.();

          return choice;
        },
        async select() {
          onChoice?.();

          return choice;
        },
      },
      async reload() {
        reloads += 1;
      },
    };
  }
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        events.set(name, handler);
      },
      registerCommand(name: string, command: { handler(args: string, context: any): unknown }) {
        commands.set(name, command);
      },
      appendEntry(customType: string, data: { additionalWorkspaces: Array<string> }) {
        snapshots.push(data);
        activeBranch.push({
          type: "custom", customType, data, id: `snapshot-${snapshots.length}`,
          parentId: activeBranch.at(-1)?.id ?? null, timestamp: "2026-01-01T00:00:00.000Z",
        } satisfies CustomEntry);
      },
    } as any,
    dependencies: {
      configFilePath: join(cwd, "unused-config.toml"),
      fileSystem: {
        async createDirectory() {
          throw new Error("Workspace mutations must not create configuration directories.");
        },
        async createFileExclusively() {
          throw new Error("Workspace mutations must not create configuration files.");
        },
        async readFile() {
          throw new Error("Workspace mutations must not read configuration files directly.");
        },
      },
      processRunner: {
        start() {
          throw new Error("Workspace mutations must not launch processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error("Workspace mutations must not load starter configuration.");
      },
      async saveConfiguration() {
        throw new Error("Workspace mutations must not save configuration.");
      },
    },
  });
  async function run({ name, args, context }: { name: string; args: string; context: ReturnType<typeof createContext> }) {
    const command = commands.get(name);
    if (command === undefined) {
      throw new Error(`Missing registered command: ${name}`);
    }
    await command.handler(args, context);
  }

  return {
    snapshots,
    notifications,
    get reloads() {
      return reloads;
    },
    get confirmations() {
      return confirmations;
    },
    async restore({ paths, eventName = "session_start" }: { paths: Array<string>; eventName?: "session_start" | "session_tree" }) {
      activeBranch = [{
        type: "custom", customType: workspaceEntryType, data: { additionalWorkspaces: paths },
        id: "restored-state", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
      } satisfies CustomEntry];
      await events.get(eventName)?.({}, createContext());
    },
    async shutdown() {
      await events.get("session_shutdown")?.({}, createContext());
    },
    async change({ name, args, decision, onConfirm, choice, onChoice }: {
      name: string;
      args: string;
      decision?: boolean | Promise<boolean>;
      onConfirm?: () => void;
      choice?: Promise<string | undefined>;
      onChoice?: () => void;
    }) {
      await run({ name, args, context: createContext({ decision, onConfirm, choice, onChoice }) });
    },
    async list() {
      await run({ name: workspaceCommands.list.name, args: "", context: createContext() });

      return notifications.at(-1);
    },
  };
}

describe("workspace mutation revision guards", () => {
  for (const kind of ["add", "remove"] as const) {
    const name = workspaceCommands[kind].name;
    it(`discards a pending ${kind} confirmation after branch restoration without changing the restored state`, async (testContext) => {
      const { cwd, target, other } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      await runtime.restore({ paths: kind === "add" ? [] : [target] });
      const waiting = createDeferred<void>();
      const decision = createDeferred<boolean>();
      const changing = runtime.change({ name, args: target, decision: decision.promise, onConfirm: () => waiting.resolve() });
      await waiting.promise;
      await runtime.restore({ paths: [other], eventName: "session_tree" });
      decision.resolve(true);
      await changing;
      assert.deepEqual(runtime.snapshots, []);
      assert.equal(runtime.reloads, 0);
      assert.deepEqual(runtime.notifications, [warningMessageTemplates.workspaceStateChanged()]);
      assert.equal(await runtime.list(), `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n  ${other}`);
    });
    it(`discards a pending ${kind} confirmation even when session restoration has an identical workspace list`, async (testContext) => {
      const { cwd, target } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      const paths = kind === "add" ? [] : [target];
      await runtime.restore({ paths });
      const waiting = createDeferred<void>();
      const decision = createDeferred<boolean>();
      const changing = runtime.change({ name, args: target, decision: decision.promise, onConfirm: () => waiting.resolve() });
      await waiting.promise;
      await runtime.restore({ paths });
      decision.resolve(true);
      await changing;
      assert.deepEqual(runtime.snapshots, []);
      assert.equal(runtime.reloads, 0);
      assert.deepEqual(runtime.notifications, [warningMessageTemplates.workspaceStateChanged()]);
    });
    it(`discards a pending ${kind} after another mutation commits without overwriting its state`, async (testContext) => {
      const { cwd, target, other } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      await runtime.restore({ paths: kind === "add" ? [] : [target] });
      const waiting = createDeferred<void>();
      const decision = createDeferred<boolean>();
      const changing = runtime.change({ name, args: target, decision: decision.promise, onConfirm: () => waiting.resolve() });
      await waiting.promise;
      await runtime.change({ name: workspaceCommands.add.name, args: other });
      decision.resolve(true);
      await changing;
      const expectedPaths = kind === "add" ? [other] : [target, other];
      assert.deepEqual(runtime.snapshots, [{ additionalWorkspaces: expectedPaths }]);
      assert.equal(runtime.reloads, 1);
      assert.deepEqual(runtime.notifications, [warningMessageTemplates.workspaceStateChanged()]);
      assert.equal(await runtime.list(), `Primary workspace:\n  ${cwd}\n\nAdditional workspaces:\n${expectedPaths.map((path) => `  ${path}`).join("\n")}`);
    });
    it(`silently discards a pending ${kind} when shutdown starts during confirmation`, async (testContext) => {
      const { cwd, target } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      await runtime.restore({ paths: kind === "add" ? [] : [target] });
      const waiting = createDeferred<void>();
      const decision = createDeferred<boolean>();
      const changing = runtime.change({ name, args: target, decision: decision.promise, onConfirm: () => waiting.resolve() });
      await waiting.promise;
      await runtime.shutdown();
      decision.resolve(true);
      await changing;
      assert.deepEqual(runtime.snapshots, []);
      assert.equal(runtime.reloads, 0);
      assert.deepEqual(runtime.notifications, []);
    });
    it(`does not admit a new ${kind} command after shutdown`, async (testContext) => {
      const { cwd, target } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      await runtime.restore({ paths: kind === "add" ? [] : [target] });
      await runtime.shutdown();
      await runtime.change({ name, args: target });
      assert.equal(runtime.confirmations, 0);
      assert.deepEqual(runtime.snapshots, []);
      assert.equal(runtime.reloads, 0);
      assert.deepEqual(runtime.notifications, []);
    });
    it(`does not ask for confirmation when ${kind} path selection returns after branch restoration`, async (testContext) => {
      const { cwd, target, other } = await createPaths(testContext);
      const runtime = createHarness(cwd);
      await runtime.restore({ paths: kind === "add" ? [] : [target] });
      const waiting = createDeferred<void>();
      const choice = createDeferred<string | undefined>();
      const changing = runtime.change({ name, args: "", choice: choice.promise, onChoice: () => waiting.resolve() });
      await waiting.promise;
      await runtime.restore({ paths: [other], eventName: "session_tree" });
      choice.resolve(target);
      await changing;
      assert.equal(runtime.confirmations, 0);
      assert.deepEqual(runtime.snapshots, []);
      assert.equal(runtime.reloads, 0);
      assert.deepEqual(runtime.notifications, [warningMessageTemplates.workspaceStateChanged()]);
    });
  }
});
