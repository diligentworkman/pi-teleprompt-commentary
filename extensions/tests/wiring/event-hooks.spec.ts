import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";

function harness(readSource?: () => Promise<string>) {
  const handlers = new Map<string, (event: any, context: any) => unknown>();
  const commands: Array<Array<string>> = [];
  let source = `
[[hooks.assistant_message_end]]
action = ["first", { var = "assistant_message_text" }]
[[hooks.assistant_message_end]]
"var:assistant_message_text" = '^unmatched$'
action = ["skip"]
[[hooks.assistant_message_end]]
action = ["second", { var = "assistant_message_text", prepend = "<", append = ">" }]
[[hooks.agent_settled]]
action = ["settled", "fixed"]
`;
  const context = { cwd: "/unused", hasUI: false, ui: {} };
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, handler); },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: "/unused/config.toml",
      fileSystem: {
        async createDirectory() { assert.fail("No filesystem mutation"); },
        async createFileExclusively() { assert.fail("No filesystem mutation"); },
        async readFile() { assert.fail("No filesystem access"); },
      },
      processRunner: {
        start({ command }) {
          commands.push(command);
          if (command[0] === "first") throw new Error("hook startup failed");
          return {
            completion: Promise.reject(new Error("hook observation failed")),
            async terminate() { return { type: "already-exited" }; },
          };
        },
        async cleanup() { return []; },
      },
      async readConfigurationFile() {
        return readSource === undefined ? source : readSource();
      },
      async readStarterConfigurationSource() { assert.fail("No starter read"); },
      async saveConfiguration() { assert.fail("No config save"); },
    },
  });
  return {
    commands,
    setSource(value: string) { source = value; },
    async emit(name: string, event: unknown) { return handlers.get(name)?.(event, context); },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

describe("event hook wiring", () => {
  for (const eventName of ["message_end", "agent_settled"] as const) {
    it(`does not launch ${eventName} hooks when shutdown completes during configuration loading`, async () => {
      const resolving = createDeferred<void>();
      const configuration = createDeferred<string>();
      const runtime = harness(() => {
        resolving.resolve();

        return configuration.promise;
      });
      const event = eventName === "message_end"
        ? { message: { role: "assistant", content: [{ type: "text", text: "completed message" }] } }
        : {};
      const dispatch = runtime.emit(eventName, event);
      await resolving.promise;
      await runtime.emit("session_shutdown", {});
      configuration.resolve('[[hooks.assistant_message_end]]\naction = ["late-message"]\n[[hooks.agent_settled]]\naction = ["late-settled"]');
      await dispatch;
      assert.deepEqual(runtime.commands, []);
    });
  }
  it("filters non-assistant messages and places tool summaries before assistant descriptions", async () => {
    const runtime = harness();
    for (const role of ["user", "toolResult", "custom"]) {
      await runtime.emit("message_end", { message: { role, content: "ignored" } });
    }
    assert.deepEqual(runtime.commands, []);
    assert.equal(await runtime.emit("message_end", {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First with spaces" },
          { type: "thinking", thinking: "private thinking" },
          { type: "toolCall", name: "write", arguments: { content: "private file content" } },
          { type: "toolCall", name: "edit", arguments: {} },
          { type: "text", text: "Second\nline" },
        ],
      },
    }), undefined);
    assert.deepEqual(runtime.commands, [
      ["first", 'Tool "write" is being called.\nTool "edit" is being called.\nFirst with spaces\nSecond\nline'],
      ["second", '<Tool "write" is being called.\nTool "edit" is being called.\nFirst with spaces\nSecond\nline>'],
    ]);
  });

  it("dispatches a tool-only summary and suppresses empty, whitespace-only, and thinking-only messages", async () => {
    const runtime = harness();
    for (const content of [[], [{ type: "text", text: " \n\t" }], [{ type: "thinking", thinking: "private" }]]) {
      await runtime.emit("message_end", { message: { role: "assistant", content } });
    }
    assert.deepEqual(runtime.commands, []);
    await runtime.emit("message_end", {
      message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: {} }] },
    });
    assert.deepEqual(runtime.commands, [
      ["first", 'Tool "write" is being called.'],
      ["second", '<Tool "write" is being called.>'],
    ]);
  });

  it("dispatches only at native agent_settled, rereads configuration, and suppresses hooks after shutdown", async () => {
    const runtime = harness();
    await runtime.emit("agent_end", {});
    assert.deepEqual(runtime.commands, []);
    await runtime.emit("agent_settled", {});
    assert.deepEqual(runtime.commands, [["settled", "fixed"]]);
    runtime.setSource('[[hooks.agent_settled]]\naction = ["updated"]');
    await runtime.emit("agent_settled", {});
    assert.deepEqual(runtime.commands, [["settled", "fixed"], ["updated"]]);
    await runtime.emit("session_shutdown", {});
    await runtime.emit("agent_settled", {});
    await runtime.emit("message_end", { message: { role: "assistant", content: [] } });
    assert.equal(runtime.commands.length, 2);
  });
});
