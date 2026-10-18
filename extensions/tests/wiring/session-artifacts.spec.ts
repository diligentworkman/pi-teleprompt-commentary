import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { registerTelepromptCommentary } from "#/index.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

type PathToolName = "read" | "write" | "edit" | "grep" | "find" | "ls";

function pathToolEvent(toolName: PathToolName, path: string): ToolCallEvent {
  const event = { type: "tool_call" as const, toolCallId: `${toolName}-call` };
  switch (toolName) {
    case "read":
      return { ...event, toolName, input: { path } };
    case "write":
      return { ...event, toolName, input: { path, content: "proposal" } };
    case "edit":
      return { ...event, toolName, input: { path, edits: [{ oldText: "original", newText: "proposal" }] } };
    case "grep":
      return { ...event, toolName, input: { path, pattern: "plan" } };
    case "find":
      return { ...event, toolName, input: { path, pattern: "*.md" } };
    case "ls":
      return { ...event, toolName, input: { path } };
  }
}

async function fixture(testContext: TestContext, {
  hasUI = true,
  configurationSource = "",
  throwOnWarning = false,
}: {
  hasUI?: boolean;
  configurationSource?: string;
  throwOnWarning?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-artifact-wiring-")));
  const cwd = join(root, "workspace");
  const agentDirectoryPath = join(root, "agent");
  const initialSessionId = "session-123";
  const sessionFilePath = join(root, "sessions", "session.jsonl");
  const artifactsRoot = join(agentDirectoryPath, "teleprompt-commentary", "artifacts", initialSessionId);
  const confirmations: Array<{ title: string; message: string }> = [];
  const selections: Array<string> = [];
  const warnings: Array<{ message: string; level: string }> = [];
  const handlers = new Map<string, (event: any, context: any) => unknown>();
  let currentSessionId = initialSessionId;
  let currentSessionFile: string | undefined = sessionFilePath;
  const context = {
    cwd,
    hasUI,
    sessionManager: {
      getBranch() {
        return [];
      },
      getSessionId() {
        return currentSessionId;
      },
      getSessionFile() {
        return currentSessionFile;
      },
    },
    ui: {
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return false;
      },
      async select(title: string) {
        selections.push(title);
        return "Reject";
      },
      async input() {
        return undefined;
      },
      notify(message: string, level: string) {
        warnings.push({ message, level });
        if (throwOnWarning) {
          throw new Error("Warning delivery failed");
        }
      },
    },
  };
  testContext.after(async () => {
    try {
      await handlers.get("session_shutdown")?.({}, context);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(cwd);
  registerTelepromptCommentary({
    pi: {
      on(name: string, handler: (event: any, context: any) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand() {},
    } as any,
    dependencies: {
      configFilePath: join(root, "config.toml"),
      agentDirectoryPath,
      temporaryFileStore: createRuntimeTemporaryFileStore({ temporaryRootPath: root, createFileId: randomUUID }),
      fileSystem: {
        async createDirectory() { throw new Error("Unexpected configuration write"); },
        async createFileExclusively() { throw new Error("Unexpected configuration write"); },
        async readFile() { throw new Error("Unexpected configuration read"); },
      },
      processRunner: {
        start() { throw new Error("Unexpected process launch"); },
        async cleanup() { return []; },
      },
      async readConfigurationFile() { return configurationSource; },
      async readStarterConfigurationSource() { throw new Error("Unexpected starter read"); },
      async saveConfiguration() { throw new Error("Unexpected configuration save"); },
    },
  });

  return {
    root,
    cwd,
    agentDirectoryPath,
    artifactsRoot,
    sessionFilePath,
    confirmations,
    selections,
    warnings,
    setSession(sessionId: string, filePath: string | undefined) {
      currentSessionId = sessionId;
      currentSessionFile = filePath;
    },
    async emit(name: string, event: any = {}): Promise<any> {
      return handlers.get(name)!(event, context);
    },
    async call(toolName: PathToolName, path: string): Promise<any> {
      return handlers.get("tool_call")!(pathToolEvent(toolName, path), context);
    },
    async beforeAgentStart(systemPrompt = "Base system prompt"): Promise<{ systemPrompt: string }> {
      return await handlers.get("before_agent_start")!({
        type: "before_agent_start",
        prompt: "Continue the current task.",
        systemPrompt,
        systemPromptOptions: {},
      }, context) as { systemPrompt: string };
    },
  };
}

describe("session artifact wiring", () => {
  const outsideDenied = { block: true, reason: "Access outside the configured workspaces was not allowed." };
  const allowFileReviews = '[[handlers.diff_editor]]\naction = "allow"\n[[handlers.new_file_editor]]\naction = "allow"';
  for (const toolName of ["read", "write", "edit", "grep", "find", "ls"] as const) {
    it(`automatically permits ${toolName} in the active session's artifacts without UI when file-review policy allows it`, async (testContext) => {
      const runtime = await fixture(testContext, { hasUI: false, configurationSource: allowFileReviews });
      const outcome = await runtime.call(toolName, join(runtime.artifactsRoot, "plan.md"));
      assert.equal(outcome, undefined);
      assert.deepEqual(runtime.confirmations, []);
      assert.deepEqual(runtime.selections, []);
      assert.deepEqual(runtime.warnings, []);
    });
  }
  it("uses the current session on each call, revokes the previous exemption, and reuses it on resume", async (testContext) => {
    const runtime = await fixture(testContext);
    const firstPlan = join(runtime.artifactsRoot, "plan.md");
    const nextId = "session-456";
    const nextPlan = join(runtime.agentDirectoryPath, "teleprompt-commentary", "artifacts", nextId, "plan.md");
    assert.equal(await runtime.call("read", firstPlan), undefined);
    runtime.setSession(nextId, join(runtime.root, "sessions", "next.jsonl"));
    await runtime.emit("session_start", { type: "session_start", reason: "new" });
    assert.equal(await runtime.call("read", nextPlan), undefined);
    assert.deepEqual(await runtime.call("read", firstPlan), outsideDenied);
    runtime.setSession("session-123", runtime.sessionFilePath);
    await runtime.emit("session_start", { type: "session_start", reason: "resume" });
    assert.equal(await runtime.call("read", firstPlan), undefined);
    assert.deepEqual(await runtime.call("read", nextPlan), outsideDenied);
    assert.equal(runtime.confirmations.length, 2);
    assert.ok(runtime.confirmations[0]?.message.includes(firstPlan));
    assert.ok(runtime.confirmations[1]?.message.includes(nextPlan));
  });
  it("keeps the same artifact exemption after navigation within the current session tree", async (testContext) => {
    const runtime = await fixture(testContext);
    const plan = join(runtime.artifactsRoot, "plan.md");
    assert.equal(await runtime.call("read", plan), undefined);
    await runtime.emit("session_tree", { type: "session_tree" });
    assert.equal(await runtime.call("read", plan), undefined);
    assert.deepEqual(runtime.confirmations, []);
  });
  it("does not exempt artifacts for an ephemeral session even when its ID matches a persisted session", async (testContext) => {
    const runtime = await fixture(testContext);
    const plan = join(runtime.artifactsRoot, "plan.md");
    assert.equal(await runtime.call("read", plan), undefined);
    runtime.setSession("session-123", undefined);
    assert.deepEqual(await runtime.call("read", plan), outsideDenied);
    assert.equal(runtime.confirmations.length, 1);
    assert.deepEqual(runtime.warnings, []);
  });
  for (const toolName of ["write", "edit"] as const) {
    it(`still requires ${toolName} review after automatically granting artifact-path permission`, async (testContext) => {
      const runtime = await fixture(testContext);
      const plan = join(runtime.artifactsRoot, "plan.md");
      await mkdir(runtime.artifactsRoot, { recursive: true });
      await writeFile(plan, "original");
      const outcome = await runtime.call(toolName, plan);
      assert.deepEqual(outcome, { block: true, reason: "Tool call rejected by user." });
      assert.deepEqual(runtime.confirmations, []);
      assert.deepEqual(runtime.selections, ["Review tool call"]);
      assert.equal(await readFile(plan, "utf8"), "original");
    });
  }
  it("requires ordinary outside-workspace permission for a descendant symlink escaping the artifact directory", async (testContext) => {
    const runtime = await fixture(testContext);
    const outsidePath = join(runtime.root, "outside");
    const redirectPath = join(runtime.artifactsRoot, "redirect");
    const target = join(outsidePath, "plan.md");
    await mkdir(runtime.artifactsRoot, { recursive: true });
    await mkdir(outsidePath);
    await symlink(outsidePath, redirectPath, "junction");
    assert.deepEqual(await runtime.call("read", join(redirectPath, "plan.md")), outsideDenied);
    assert.equal(runtime.confirmations.length, 1);
    assert.ok(runtime.confirmations[0]?.message.includes(target));
    assert.deepEqual(runtime.warnings, []);
  });
  it("warns and withholds the exemption when the session directory redirects into another session", async (testContext) => {
    const runtime = await fixture(testContext);
    const otherSession = join(runtime.agentDirectoryPath, "teleprompt-commentary", "artifacts", "other-session");
    await mkdir(otherSession, { recursive: true });
    await symlink(otherSession, runtime.artifactsRoot, "junction");
    assert.deepEqual(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), outsideDenied);
    assert.equal(runtime.confirmations.length, 1);
    assert.ok(runtime.confirmations[0]?.message.includes(join(otherSession, "plan.md")));
    assert.deepEqual(runtime.warnings, [{
      message: "The session artifact directory is unavailable: The session artifact directory is redirected outside its expected location.",
      level: "warning",
    }]);
  });
  for (const throwOnWarning of [false, true]) {
    it(`preserves workspace access and normal outside denial after artifact resolution fails${throwOnWarning ? ", even when warning delivery throws" : ""}`, async (testContext) => {
      const runtime = await fixture(testContext, { throwOnWarning });
      runtime.setSession("../invalid", runtime.sessionFilePath);
      assert.equal(await runtime.call("read", join(runtime.cwd, "source.ts")), undefined);
      assert.deepEqual(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), outsideDenied);
      assert.equal(runtime.confirmations.length, 1);
      assert.equal(runtime.warnings.length, 2);
      for (const warning of runtime.warnings) {
        assert.deepEqual(warning, {
          message: "The session artifact directory is unavailable: The session ID is not a safe artifact-directory name.",
          level: "warning",
        });
      }
    });
  }
  describe("when announcing artifacts before an agent run", () => {
    for (const hasUI of [true, false]) {
      it(`announces the real path once per run and preserves existing prompt sections ${hasUI ? "with" : "without"} UI`, async (testContext) => {
        const runtime = await fixture(testContext, { hasUI });
        const basePrompt = "Existing system instructions";
        const first = await runtime.beforeAgentStart(basePrompt);
        const second = await runtime.beforeAgentStart(basePrompt);
        for (const { systemPrompt } of [first, second]) {
          assert.ok(systemPrompt.startsWith(`${basePrompt}\n\n`));
          assert.match(systemPrompt, /<teleprompt_commentary_communication_protocol>/);
          assert.match(systemPrompt, /<teleprompt_commentary_workspace_context>/);
          assert.ok(systemPrompt.includes(`<workspace role="primary" path="${runtime.cwd}"`));
          assert.ok(systemPrompt.includes(`<teleprompt_commentary_session_artifacts availability="available" path="${runtime.artifactsRoot}">`));
          assert.equal(systemPrompt.match(/<teleprompt_commentary_session_artifacts\b/g)?.length, 1);
          assert.doesNotMatch(systemPrompt, /SESSION_ARTIFACT_DIRECTORY/);
        }
        assert.equal(first.systemPrompt, second.systemPrompt);
        await assert.rejects(lstat(runtime.artifactsRoot), { code: "ENOENT" });
        assert.deepEqual(runtime.warnings, []);
      });
    }
    for (const { command, reason } of [
      { command: "/new", reason: "new" },
      { command: "/fork", reason: "fork" },
      { command: "/clone", reason: "fork" },
    ]) {
      it(`refreshes the advertised path and permissions after the session-start contract used by ${command}`, async (testContext) => {
        const runtime = await fixture(testContext);
        const original = await runtime.beforeAgentStart();
        const nextSessionId = "next-session";
        const nextRoot = join(runtime.agentDirectoryPath, "teleprompt-commentary", "artifacts", nextSessionId);
        assert.ok(original.systemPrompt.includes(`path="${runtime.artifactsRoot}"`));
        runtime.setSession(nextSessionId, join(runtime.root, "sessions", "next.jsonl"));
        await runtime.emit("session_start", { type: "session_start", reason });
        const updated = await runtime.beforeAgentStart();
        assert.ok(updated.systemPrompt.includes(`path="${nextRoot}"`));
        assert.equal(updated.systemPrompt.includes(runtime.artifactsRoot), false);
        assert.equal(await runtime.call("read", join(nextRoot, "plan.md")), undefined);
        assert.deepEqual(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), outsideDenied);
        await assert.rejects(lstat(nextRoot), { code: "ENOENT" });
      });
    }
    it("restores the original advertised path on resume and keeps it across tree navigation", async (testContext) => {
      const runtime = await fixture(testContext);
      const original = await runtime.beforeAgentStart();
      runtime.setSession("another-session", join(runtime.root, "sessions", "another.jsonl"));
      const other = await runtime.beforeAgentStart();
      assert.notEqual(other.systemPrompt, original.systemPrompt);
      runtime.setSession("session-123", runtime.sessionFilePath);
      await runtime.emit("session_start", { type: "session_start", reason: "resume" });
      const resumed = await runtime.beforeAgentStart();
      await runtime.emit("session_tree", { type: "session_tree" });
      const branched = await runtime.beforeAgentStart();
      assert.equal(resumed.systemPrompt, original.systemPrompt);
      assert.equal(branched.systemPrompt, original.systemPrompt);
      assert.equal(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), undefined);
      assert.deepEqual(runtime.confirmations, []);
    });
    it("replaces a previously advertised path with a disabled notice for an ephemeral session", async (testContext) => {
      const runtime = await fixture(testContext);
      const original = await runtime.beforeAgentStart();
      assert.ok(original.systemPrompt.includes(`path="${runtime.artifactsRoot}"`));
      runtime.setSession("session-123", undefined);
      const disabled = await runtime.beforeAgentStart();
      assert.match(disabled.systemPrompt, /<teleprompt_commentary_session_artifacts availability="disabled">/);
      assert.equal(disabled.systemPrompt.includes(runtime.artifactsRoot), false);
      assert.match(disabled.systemPrompt, /Keep plans and TODOs in the conversation/);
      assert.deepEqual(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), outsideDenied);
      assert.deepEqual(runtime.warnings, []);
    });
    it("announces an unsafe-ID failure without replacing the base or workspace context", async (testContext) => {
      const runtime = await fixture(testContext, { hasUI: false });
      runtime.setSession("../invalid", runtime.sessionFilePath);
      const result = await runtime.beforeAgentStart("Existing system instructions");
      assert.ok(result.systemPrompt.startsWith("Existing system instructions\n\n"));
      assert.ok(result.systemPrompt.includes(`<workspace role="primary" path="${runtime.cwd}"`));
      assert.match(result.systemPrompt, /<teleprompt_commentary_session_artifacts availability="unavailable" reason="The session ID is not a safe artifact-directory name\."/);
      assert.equal(result.systemPrompt.includes(runtime.artifactsRoot), false);
      assert.equal(await runtime.call("read", join(runtime.cwd, "source.ts")), undefined);
      assert.deepEqual(runtime.warnings, []);
    });
    it("refreshes an available notice after a redirect appears and recovers when the redirect is removed", async (testContext) => {
      const runtime = await fixture(testContext);
      const original = await runtime.beforeAgentStart();
      const otherSession = join(runtime.agentDirectoryPath, "teleprompt-commentary", "artifacts", "other-session");
      await mkdir(otherSession, { recursive: true });
      await symlink(otherSession, runtime.artifactsRoot, "junction");
      const unavailable = await runtime.beforeAgentStart();
      assert.match(unavailable.systemPrompt, /<teleprompt_commentary_session_artifacts availability="unavailable"/);
      assert.equal(unavailable.systemPrompt.includes(runtime.artifactsRoot), false);
      assert.deepEqual(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), outsideDenied);
      await rm(runtime.artifactsRoot);
      const recovered = await runtime.beforeAgentStart();
      assert.equal(recovered.systemPrompt, original.systemPrompt);
      assert.equal(await runtime.call("read", join(runtime.artifactsRoot, "plan.md")), undefined);
    });
  });
  it("retains existing artifacts after extension shutdown", async (testContext) => {
    const runtime = await fixture(testContext);
    const plan = join(runtime.artifactsRoot, "plan.md");
    const content = "Persistent implementation plan.\n";
    await mkdir(runtime.artifactsRoot, { recursive: true });
    await writeFile(plan, content);
    assert.equal(await runtime.call("read", plan), undefined);
    await runtime.emit("session_shutdown", { type: "session_shutdown" });
    assert.equal(await readFile(plan, "utf8"), content);
  });
});
