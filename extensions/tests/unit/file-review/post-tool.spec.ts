import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt } from "#/errors/index.ts";
import { applyFilePostToolActions } from "#/file-review/post-tool.ts";

async function fixture(testContext: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-file-result-")));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("file post-tool actions", () => {
  it("applies empty reviewed bytes even when Pi's original result was an error", async (testContext) => {
    const root = await fixture(testContext);
    const target = join(root, "file.txt");
    await writeFile(target, "normal tool partial output");
    const originalContent = [{ type: "text" as const, text: "Pi's native failure" }];
    const annotated = await applyFilePostToolActions({
      actions: [
        { type: "append-user-feedback", feedback: "Please keep it empty." },
        { type: "apply-reviewed-content", canonicalPath: target, content: Buffer.alloc(0) },
      ],
      content: originalContent,
    });
    assert.deepEqual(await readFile(target), Buffer.alloc(0));
    assert.equal(annotated[0], originalContent[0]);
    assert.match(annotated[1]?.type === "text" ? annotated[1].text : "", /reviewed file content was applied/);
    assert.match(annotated[2]?.type === "text" ? annotated[2].text : "", /User feedback.*keep it empty/);
    assert.deepEqual(originalContent, [{ type: "text", text: "Pi's native failure" }]);
  });

  it("reports application failure without claiming success or losing feedback", async () => {
    const originalError = new Error("disk unavailable");
    const originalContent = [{ type: "text" as const, text: "Original result" }];
    const annotated = await applyFilePostToolActions({
      actions: [
        { type: "apply-reviewed-content", canonicalPath: "/target", content: Buffer.from("private diff") },
        { type: "append-user-feedback", feedback: "My note" },
      ],
      content: originalContent,
      async applyReviewedContent() { return attempt.error(originalError); },
    });
    assert.equal(annotated[0], originalContent[0]);
    assert.match(annotated[1]?.type === "text" ? annotated[1].text : "", /could not be applied: disk unavailable/);
    assert.equal(JSON.stringify(annotated).includes("private diff"), false);
    assert.match(annotated[2]?.type === "text" ? annotated[2].text : "", /My note/);
  });

  it("returns original blocks unchanged when no actions exist", async () => {
    const content = [{ type: "text" as const, text: "Original result" }];
    assert.equal(await applyFilePostToolActions({ actions: [], content }), content);
  });
});
