import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { assessWorkspacePaths } from "#/path-permissions/index.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-artifact-permission-")));
  testContext.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const workspacePath = join(root, "workspace");
  const sessionArtifactsRoot = join(root, "agent", "teleprompt-commentary", "artifacts", "session-123");
  await mkdir(workspacePath);

  return {
    root,
    workspacePath,
    input: {
      workspacePaths: [workspacePath],
      sessionArtifactsRoot,
      cwd: workspacePath,
      homeDirectory: join(root, "home"),
    },
  };
}

describe("session artifact path permission assessment", () => {
  for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
    it(`permits the validated artifact root and its descendants for ${toolName} without creating directories`, async (testContext) => {
      const { input } = await fixture(testContext);
      const paths = [input.sessionArtifactsRoot, join(input.sessionArtifactsRoot, "plans", "implementation.md")];
      const assessment = await assessWorkspacePaths({ ...input, toolName, requestedPaths: paths });
      assert.deepEqual(assessment, { type: "inside", canonicalPaths: paths });
      await assert.rejects(lstat(input.sessionArtifactsRoot), { code: "ENOENT" });
    });
  }
  it("keeps artifacts outside the automatic permission boundary when no validated root is supplied", async (testContext) => {
    const { input } = await fixture(testContext);
    const { sessionArtifactsRoot, ...withoutArtifactRoot } = input;
    const target = join(sessionArtifactsRoot, "plan.md");
    const assessment = await assessWorkspacePaths({ ...withoutArtifactRoot, requestedPaths: [target] });
    assert.deepEqual(assessment, { type: "outside", canonicalPaths: [target], outsidePaths: [target] });
  });
  it("does not permit the collection parent, another session, or a similarly named sibling", async (testContext) => {
    const { input } = await fixture(testContext);
    const collectionPath = dirname(input.sessionArtifactsRoot);
    const outsidePaths = [
      collectionPath,
      join(collectionPath, "other-session", "plan.md"),
      join(`${input.sessionArtifactsRoot}-other`, "plan.md"),
    ];
    const assessment = await assessWorkspacePaths({ ...input, requestedPaths: outsidePaths });
    assert.deepEqual(assessment, { type: "outside", canonicalPaths: outsidePaths, outsidePaths });
  });
  it("combines workspace and artifact access while retaining unrelated outside paths in request order", async (testContext) => {
    const { root, workspacePath, input } = await fixture(testContext);
    const workspacePaths = [...input.workspacePaths];
    const firstOutside = join(root, "first-outside.md");
    const secondOutside = join(root, "second-outside.md");
    const paths = [
      firstOutside,
      join(workspacePath, "source.ts"),
      join(input.sessionArtifactsRoot, "plan.md"),
      secondOutside,
    ];
    const assessment = await assessWorkspacePaths({ ...input, requestedPaths: paths });
    assert.deepEqual(assessment, {
      type: "outside",
      canonicalPaths: paths,
      outsidePaths: [firstOutside, secondOutside],
    });
    assert.deepEqual(input.workspacePaths, workspacePaths);
  });
  for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
    it(`does not exempt a ${toolName} target reached through a symlink escaping the artifact root`, async (testContext) => {
      const { root, input } = await fixture(testContext);
      const outsideDirectory = join(root, "outside");
      const linkPath = join(input.sessionArtifactsRoot, "redirect");
      await mkdir(input.sessionArtifactsRoot, { recursive: true });
      await mkdir(outsideDirectory);
      await symlink(outsideDirectory, linkPath, "junction");
      const assessment = await assessWorkspacePaths({
        ...input,
        toolName,
        requestedPaths: [join(linkPath, "plan.md")],
      });
      const canonicalTarget = join(outsideDirectory, "plan.md");
      assert.deepEqual(assessment, {
        type: "outside",
        canonicalPaths: [canonicalTarget],
        outsidePaths: [canonicalTarget],
      });
    });
  }
  it("does not regrant access to a replacement symlink at the previously validated artifact root", async (testContext) => {
    const { root, input } = await fixture(testContext);
    const movedDirectory = join(root, "moved-artifacts");
    const outsideDirectory = join(root, "outside");
    await mkdir(input.sessionArtifactsRoot, { recursive: true });
    await rename(input.sessionArtifactsRoot, movedDirectory);
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, input.sessionArtifactsRoot, "junction");
    const assessment = await assessWorkspacePaths({
      ...input,
      requestedPaths: [join(input.sessionArtifactsRoot, "plan.md")],
    });
    const canonicalTarget = join(outsideDirectory, "plan.md");
    assert.deepEqual(assessment, {
      type: "outside",
      canonicalPaths: [canonicalTarget],
      outsidePaths: [canonicalTarget],
    });
  });
  it("preserves a literal Unicode-space artifact root without exempting its ordinary-space sibling", async (testContext) => {
    const { root, input } = await fixture(testContext);
    const literalRoot = join(root, "artifacts", "session\u00A0name");
    const literalTarget = join(literalRoot, "plan.md");
    const siblingTarget = join(root, "artifacts", "session name", "plan.md");
    const assessment = await assessWorkspacePaths({
      ...input,
      sessionArtifactsRoot: literalRoot,
      requestedPaths: [pathToFileURL(literalTarget).href, siblingTarget],
    });
    assert.deepEqual(assessment, {
      type: "outside",
      canonicalPaths: [literalTarget, siblingTarget],
      outsidePaths: [siblingTarget],
    });
  });
});
