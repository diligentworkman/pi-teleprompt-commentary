import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt } from "#/errors/index.ts";
import { resolveSessionArtifactsAccessRoot, resolveSessionArtifactsPath } from "#/session-artifacts/utils.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-artifact-path-")));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    agentDirectoryPath: join(root, "agent"),
    sessionFilePath: join(root, "sessions", "session.jsonl"),
  };
}

describe("session artifact path resolution", () => {
  const sessionId = "session-123";
  const unsafeSessionIdMessage = "The session ID is not a safe artifact-directory name.";
  describe("when the session is persisted", () => {
    it("resolves an absolute session-specific directory without creating files or requiring the session file to exist", async (testContext) => {
      const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const result = resolveSessionArtifactsPath({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.deepEqual(result, attempt.value(
        join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId),
      ));
      assert.deepEqual(await readdir(root), []);
    });
    it("reuses the same directory when the same session is resolved again", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const input = { agentDirectoryPath, sessionId, sessionFilePath };
      const first = resolveSessionArtifactsPath(input);
      const resumed = resolveSessionArtifactsPath(input);
      assert.deepEqual(first, attempt.value(
        join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId),
      ));
      assert.deepEqual(resumed, first);
    });
    it("gives a different session its own directory under the same artifact root", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const nextSessionId = "session-456";
      const first = resolveSessionArtifactsPath({ agentDirectoryPath, sessionId, sessionFilePath });
      const next = resolveSessionArtifactsPath({
        agentDirectoryPath,
        sessionId: nextSessionId,
        sessionFilePath,
      });
      assert.deepEqual(first, attempt.value(
        join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId),
      ));
      assert.deepEqual(next, attempt.value(
        join(agentDirectoryPath, "teleprompt-commentary", "artifacts", nextSessionId),
      ));
      assert.notEqual(first.value, next.value);
    });
    for (const safeSessionId of ["session 123", "session.123", ".session-123", "会話-123"]) {
      it(`accepts the safe directory name ${JSON.stringify(safeSessionId)} without copying Pi's ID grammar`, async (testContext) => {
        const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
        const result = resolveSessionArtifactsPath({
          agentDirectoryPath,
          sessionId: safeSessionId,
          sessionFilePath,
        });
        assert.deepEqual(result, attempt.value(
          join(agentDirectoryPath, "teleprompt-commentary", "artifacts", safeSessionId),
        ));
      });
    }
  });
  describe("when the session is ephemeral", () => {
    it("returns no artifact path even though the session has an ID", async (testContext) => {
      const { root, agentDirectoryPath } = await fixture(testContext);
      const result = resolveSessionArtifactsPath({
        agentDirectoryPath,
        sessionId,
        sessionFilePath: undefined,
      });
      assert.deepEqual(result, attempt.value(undefined));
      assert.deepEqual(await readdir(root), []);
    });
    it("disables artifacts before interpreting the ephemeral session's ID as a directory name", async (testContext) => {
      const { agentDirectoryPath } = await fixture(testContext);
      const result = resolveSessionArtifactsPath({
        agentDirectoryPath,
        sessionId: `..${sep}other`,
        sessionFilePath: undefined,
      });
      assert.deepEqual(result, attempt.value(undefined));
    });
  });
  describe("when resolving the filesystem access root", () => {
    const redirectedDirectoryMessage = "The session artifact directory is redirected outside its expected location.";
    it("allows a missing directory without creating it or any parents", async (testContext) => {
      const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.deepEqual(result, attempt.value(
        join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId),
      ));
      assert.deepEqual(await readdir(root), []);
    });
    it("allows an existing directory without changing its contents", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const directoryPath = join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId);
      const planPath = join(directoryPath, "plan.md");
      const plan = "Keep this implementation plan.\n";
      await mkdir(directoryPath, { recursive: true });
      await writeFile(planPath, plan);
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.deepEqual(result, attempt.value(directoryPath));
      assert.deepEqual(await readdir(directoryPath), ["plan.md"]);
      assert.equal(await readFile(planPath, "utf8"), plan);
    });
    for (const existing of [false, true]) {
      it(`supports a configured agent-directory symlink with ${existing ? "an existing" : "a missing"} session artifact directory`, async (testContext) => {
        const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
        const actualAgentDirectory = join(root, "actual-agent");
        const expectedPath = join(actualAgentDirectory, "teleprompt-commentary", "artifacts", sessionId);
        await mkdir(existing ? expectedPath : actualAgentDirectory, { recursive: true });
        await symlink(actualAgentDirectory, agentDirectoryPath, "junction");
        const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
        assert.deepEqual(result, attempt.value(expectedPath));
        if (!existing) {
          assert.deepEqual(await readdir(actualAgentDirectory), []);
        }
      });
    }
    for (const [index, level] of ["extension", "artifact collection", "session"].entries()) {
      it(`rejects a redirect at the ${level} directory without touching its destination`, async (testContext) => {
        const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
        const components = ["teleprompt-commentary", "artifacts", sessionId];
        const redirectPath = join(agentDirectoryPath, ...components.slice(0, index + 1));
        const destination = join(root, "other-location");
        await mkdir(dirname(redirectPath), { recursive: true });
        await mkdir(destination);
        await symlink(destination, redirectPath, "junction");
        const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
        assert.equal(result.success, false);
        assert.ok(result.error instanceof Error);
        assert.equal(result.error.message, redirectedDirectoryMessage);
        assert.deepEqual(await readdir(destination), []);
      });
    }
    it("rejects a session-directory symlink into another session's artifacts", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const artifactsRootPath = join(agentDirectoryPath, "teleprompt-commentary", "artifacts");
      const otherSessionPath = join(artifactsRootPath, "other-session");
      const otherPlanPath = join(otherSessionPath, "plan.md");
      const otherPlan = "Other session's plan.\n";
      await mkdir(otherSessionPath, { recursive: true });
      await writeFile(otherPlanPath, otherPlan);
      await symlink(otherSessionPath, join(artifactsRootPath, sessionId), "junction");
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.error.message, redirectedDirectoryMessage);
      assert.equal(await readFile(otherPlanPath, "utf8"), otherPlan);
    });
    it("rejects a dangling session-directory redirect instead of granting its future destination", async (testContext) => {
      const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const artifactsRootPath = join(agentDirectoryPath, "teleprompt-commentary", "artifacts");
      const destination = join(root, "missing-destination");
      await mkdir(artifactsRootPath, { recursive: true });
      await symlink(destination, join(artifactsRootPath, sessionId), "junction");
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.error.message, redirectedDirectoryMessage);
      assert.deepEqual(await readdir(root), ["agent"]);
    });
    it("rejects a regular file at the session artifact path without modifying it", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const artifactsRootPath = join(agentDirectoryPath, "teleprompt-commentary", "artifacts");
      const artifactPath = join(artifactsRootPath, sessionId);
      const content = "Not a directory.\n";
      await mkdir(artifactsRootPath, { recursive: true });
      await writeFile(artifactPath, content);
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.error.message, "The session artifact path is not a directory.");
      assert.equal(await readFile(artifactPath, "utf8"), content);
    });
    it("retains filesystem error details when an ancestor is a regular file", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const ancestorPath = join(agentDirectoryPath, "teleprompt-commentary");
      const content = "Not a directory.\n";
      await mkdir(agentDirectoryPath);
      await writeFile(ancestorPath, content);
      const result = await resolveSessionArtifactsAccessRoot({ agentDirectoryPath, sessionId, sessionFilePath });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal("code" in result.error ? result.error.code : undefined, "ENOTDIR");
      assert.equal("syscall" in result.error ? result.error.syscall : undefined, "lstat");
      assert.equal(await readFile(ancestorPath, "utf8"), content);
    });
    it("disables access for ephemeral sessions without attempting to resolve an invalid filesystem path", async (testContext) => {
      const { root, agentDirectoryPath } = await fixture(testContext);
      const result = await resolveSessionArtifactsAccessRoot({
        agentDirectoryPath: join(agentDirectoryPath, "\0"),
        sessionId,
        sessionFilePath: undefined,
      });
      assert.deepEqual(result, attempt.value(undefined));
      assert.deepEqual(await readdir(root), []);
    });
    it("returns an unsafe-ID error before attempting filesystem resolution", async (testContext) => {
      const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const result = await resolveSessionArtifactsAccessRoot({
        agentDirectoryPath: join(agentDirectoryPath, "\0"),
        sessionId: `..${sep}other`,
        sessionFilePath,
      });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.error.message, unsafeSessionIdMessage);
      assert.deepEqual(await readdir(root), []);
    });
  });
  describe("when the ID is not one unchanged child directory name", () => {
    for (const invalidSessionId of [
      "",
      ".",
      "..",
      `..${sep}other`,
      `nested${sep}session`,
      `nested${sep}..${sep}other`,
      `session${sep}`,
      "session\0other",
    ]) {
      it(`returns a typed error instead of throwing for ${JSON.stringify(invalidSessionId)}`, async (testContext) => {
        const { root, agentDirectoryPath, sessionFilePath } = await fixture(testContext);
        const result = resolveSessionArtifactsPath({
          agentDirectoryPath,
          sessionId: invalidSessionId,
          sessionFilePath,
        });
        assert.equal(result.success, false);
        assert.equal(result.value, undefined);
        assert.ok(result.error instanceof Error);
        assert.equal(result.error.message, unsafeSessionIdMessage);
        assert.deepEqual(await readdir(root), []);
      });
    }
    it("rejects an absolute ID even when it points directly inside the artifact root", async (testContext) => {
      const { agentDirectoryPath, sessionFilePath } = await fixture(testContext);
      const result = resolveSessionArtifactsPath({
        agentDirectoryPath,
        sessionId: join(agentDirectoryPath, "teleprompt-commentary", "artifacts", sessionId),
        sessionFilePath,
      });
      assert.equal(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.equal(result.error.message, unsafeSessionIdMessage);
    });
  });
});
