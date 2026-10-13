import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import { pathReservationBlockMessageTemplates } from "#/path-reservations/messages.ts";

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-reservations-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

function createPathReservationHarness({
  cwd,
  confirmOutsideAccess = true,
}: {
  cwd: string;
  confirmOutsideAccess?: boolean;
}) {
  const eventHandlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  let outsideAccessAllowed = confirmOutsideAccess;
  const context = {
    cwd,
    hasUI: true,
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    ui: {
      notify() {},
      async confirm() {
        return outsideAccessAllowed;
      },
      async select() {
        return "Accept";
      },
      async input() {
        return undefined;
      },
    },
  };
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
      configFilePath: join(cwd, "config", "config.toml"),
      fileSystem: {
        async createDirectory() {
          throw new Error("Reservation wiring must not create directories.");
        },
        async createFileExclusively() {
          throw new Error("Reservation wiring must not create files.");
        },
        async readFile() {
          throw new Error("Reservation wiring must not read files.");
        },
      },
      processRunner: {
        start() {
          throw new Error("Reservation wiring must not start processes.");
        },
        async cleanup() {
          return [];
        },
      },
      async readConfigurationFile() {
        return "";
      },
      async readStarterConfigurationSource() {
        throw new Error("Reservation wiring must not read starter config.");
      },
      async saveConfiguration() {
        throw new Error("Reservation wiring must not save config.");
      },
    },
  });

  async function emit(name: string, event: unknown) {
    const handlers = eventHandlers.get(name);
    if (!handlers || handlers.length !== 1) {
      throw new Error(`The harness requires one ${name} handler.`);
    }

    return handlers[0](event, context);
  }

  return {
    async start() {
      await emit("session_start", { type: "session_start" });
    },
    toolCall(event: ToolCallEvent) {
      return emit("tool_call", event);
    },
    toolResult(toolCallId: string) {
      return emit("tool_result", { type: "tool_result", toolCallId });
    },
    toolExecutionEnd(toolCallId: string) {
      return emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId,
      });
    },
    shutdown() {
      return emit("session_shutdown", { type: "session_shutdown" });
    },
    setOutsideAccessAllowed(allowed: boolean) {
      outsideAccessAllowed = allowed;
    },
  };
}

function createEditEvent({
  toolCallId,
  path,
}: {
  toolCallId: string;
  path: string;
}): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "edit",
    input: { path, oldText: "old", newText: "new" },
  };
}

function createWriteEvent({
  toolCallId,
  path,
}: {
  toolCallId: string;
  path: string;
}): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "write",
    input: { path, content: "content" },
  };
}

describe("path reservation wiring", () => {
  describe("acquisition", () => {
    it("blocks an edit when a write owns the same canonical path", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "target.txt");
      const harness = createPathReservationHarness({ cwd });
      await harness.start();
      assert.equal(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "owner", path: targetPath }),
        ),
        undefined,
      );
      assert.deepEqual(
        await harness.toolCall(
          createEditEvent({ toolCallId: "contender", path: targetPath }),
        ),
        {
          block: true,
          reason: pathReservationBlockMessageTemplates.conflict({
            canonicalPath: targetPath,
            currentOwnerToolCallId: "owner",
          }),
        },
      );
    });
    it("blocks a write when an edit owns the same canonical path", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "target.txt");
      const harness = createPathReservationHarness({ cwd });
      await harness.start();
      assert.equal(
        await harness.toolCall(
          createEditEvent({ toolCallId: "owner", path: targetPath }),
        ),
        undefined,
      );
      assert.deepEqual(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "contender", path: targetPath }),
        ),
        {
          block: true,
          reason: pathReservationBlockMessageTemplates.conflict({
            canonicalPath: targetPath,
            currentOwnerToolCallId: "owner",
          }),
        },
      );
    });
    it("does not reserve paths for non-mutating tools", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "target.txt");
      const harness = createPathReservationHarness({ cwd });
      await harness.start();
      assert.equal(
        await harness.toolCall({
          type: "tool_call",
          toolCallId: "reader",
          toolName: "read",
          input: { path: targetPath },
        }),
        undefined,
      );
      assert.equal(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "writer", path: targetPath }),
        ),
        undefined,
      );
    });
    it("does not reserve a path before workspace permission succeeds", async (testContext) => {
      const temporaryRoot = await createTemporaryDirectory(testContext);
      const cwd = join(temporaryRoot, "workspace");
      const targetPath = join(temporaryRoot, "outside.txt");
      await mkdir(cwd);
      const harness = createPathReservationHarness({
        cwd,
        confirmOutsideAccess: false,
      });
      await harness.start();
      const blocked = await harness.toolCall(
        createWriteEvent({ toolCallId: "denied", path: targetPath }),
      );
      assert.equal(typeof blocked, "object");
      harness.setOutsideAccessAllowed(true);
      assert.equal(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "allowed", path: targetPath }),
        ),
        undefined,
      );
    });
  });
  describe("cleanup", () => {
    for (const lifecycleEvent of [
      "tool_result",
      "tool_execution_end",
    ] as const) {
      it(`releases after ${lifecycleEvent}`, async (testContext) => {
        const cwd = await createTemporaryDirectory(testContext);
        const targetPath = join(cwd, "target.txt");
        const harness = createPathReservationHarness({ cwd });
        await harness.start();
        await harness.toolCall(
          createWriteEvent({ toolCallId: "first", path: targetPath }),
        );
        if (lifecycleEvent === "tool_result") {
          await harness.toolResult("first");
        } else {
          await harness.toolExecutionEnd("first");
        }
        assert.equal(
          await harness.toolCall(
            createWriteEvent({ toolCallId: "second", path: targetPath }),
          ),
          undefined,
        );
      });
    }
    it("clears reservations during session shutdown", async (testContext) => {
      const cwd = await createTemporaryDirectory(testContext);
      const targetPath = join(cwd, "target.txt");
      const harness = createPathReservationHarness({ cwd });
      await harness.start();
      await harness.toolCall(
        createWriteEvent({ toolCallId: "first", path: targetPath }),
      );
      await harness.shutdown();
      assert.deepEqual(
        await harness.toolCall(
          createWriteEvent({ toolCallId: "second", path: targetPath }),
        ),
        { block: true, reason: "The file review was blocked because review is shutting down." },
      );
    });
  });
});
