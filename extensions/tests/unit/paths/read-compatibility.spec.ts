import { assessWorkspacePaths } from "#/path-permissions/index.ts";
import { resolveInputPath, resolveReadCandidate } from "#/paths/index.ts";
import { createReadToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

async function createRoot(testContext: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-read-compatibility-")));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return root;
}

describe("Pi read fallback compatibility and permission boundaries", () => {
  describe("when selecting the native read candidate", () => {
    const cases = [
      { kind: "AM/PM space", input: "Screenshot 10 AM.txt", candidate: "Screenshot 10\u202FAM.txt" },
      { kind: "decomposed Unicode", input: "caf\u00E9.txt", candidate: "cafe\u0301.txt" },
      { kind: "curly apostrophe", input: "report's.txt", candidate: "report\u2019s.txt" },
      { kind: "combined Unicode and apostrophe", input: "caf\u00E9's.txt", candidate: "cafe\u0301\u2019s.txt" },
    ];
    for (const { kind, input, candidate } of cases) {
      it(`selects the same ${kind} fallback as the actual native read tool`, async (testContext) => {
        const root = await createRoot(testContext);
        const target = join(root, candidate);
        const marker = "native fallback content";
        await writeFile(target, marker);
        const normalized = resolveInputPath({ inputPath: input, cwd: root, homeDirectory: root });
        const selected = await resolveReadCandidate(normalized);
        assert.equal(await realpath(selected), await realpath(target));
        const result = await createReadToolDefinition(root).execute(
          "read-compatibility", { path: input }, undefined, undefined, { cwd: root } as ExtensionToolContext,
        );
        assert.deepEqual(result.content, [{ type: "text", text: marker }]);
      });
    }
    it("prefers an existing original name over an existing fallback, matching native read", async (testContext) => {
      const root = await createRoot(testContext);
      const input = "report's.txt";
      const target = join(root, input);
      const marker = "original content";
      await writeFile(target, marker);
      await writeFile(join(root, "report\u2019s.txt"), "fallback content");
      assert.equal(await resolveReadCandidate(target), target);
      const result = await createReadToolDefinition(root).execute(
        "original-precedence", { path: input }, undefined, undefined, { cwd: root } as ExtensionToolContext,
      );
      assert.deepEqual(result.content, [{ type: "text", text: marker }]);
    });
    it("returns the original path when no candidate exists so native read can report its own error", async (testContext) => {
      const root = await createRoot(testContext);
      const target = join(root, "missing's.txt");
      assert.equal(await resolveReadCandidate(target), target);
    });
  });
  describe("when a fallback symlink points outside the workspace", () => {
    it("classifies native read's actual target as outside without applying read fallbacks to write", async (testContext) => {
      const root = await createRoot(testContext);
      const cwd = join(root, "workspace");
      await mkdir(cwd);
      const outsidePath = join(root, "outside.txt");
      const marker = "outside content";
      await writeFile(outsidePath, marker);
      await symlink(outsidePath, join(cwd, "report\u2019s.txt"));
      const input = "report's.txt";
      const readAssessment = await assessWorkspacePaths({
        requestedPaths: [input], workspacePaths: [cwd], cwd, homeDirectory: root, toolName: "read",
      });
      assert.deepEqual(readAssessment, {
        type: "outside", canonicalPaths: [outsidePath], outsidePaths: [outsidePath],
      });
      const result = await createReadToolDefinition(cwd).execute(
        "outside-fallback", { path: input }, undefined, undefined, { cwd } as ExtensionToolContext,
      );
      assert.deepEqual(result.content, [{ type: "text", text: marker }]);
      const writeAssessment = await assessWorkspacePaths({
        requestedPaths: [input], workspacePaths: [cwd], cwd, homeDirectory: root, toolName: "write",
      });
      assert.deepEqual(writeAssessment, { type: "inside", canonicalPaths: [join(cwd, input)] });
    });
  });
});
