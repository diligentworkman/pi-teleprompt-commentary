import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { attempt } from "#/errors/index.ts";
import { applyFilePostToolActions } from "#/file-review/index.ts";

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

  describe("when reviewed content has a change summary result", () => {
    const summary = "User review changes (agent proposal → reviewed content):\n- Modified: proposal line 1 → reviewed line 1";
    it("appends the summary after successfully applying reviewed bytes without altering native result blocks", async (testContext) => {
      const root = await fixture(testContext);
      const target = join(root, "file.txt");
      const reviewed = Buffer.from("reviewed content\n");
      const originalContent = [{ type: "text" as const, text: "Pi's native output" }];
      const annotated = await applyFilePostToolActions({
        actions: [
          {
            type: "apply-reviewed-content",
            canonicalPath: target,
            content: reviewed,
            changeSummary: attempt.value(summary),
          },
          { type: "append-user-feedback", feedback: "Keep this change." },
        ],
        content: originalContent,
      });
      assert.deepEqual(await readFile(target), reviewed);
      assert.equal(annotated[0], originalContent[0]);
      assert.deepEqual(annotated.slice(1), [
        { type: "text", text: "The user's reviewed file content was applied after Pi's tool call." },
        { type: "text", text: summary },
        { type: "text", text: "User feedback on approval: Keep this change." },
      ]);
      assert.deepEqual(originalContent, [{ type: "text", text: "Pi's native output" }]);
    });
    it("adds no summary annotation when summary generation succeeded without reportable changes", async (testContext) => {
      const root = await fixture(testContext);
      const target = join(root, "file.txt");
      const reviewed = Buffer.from("reviewed content\n");
      const annotated = await applyFilePostToolActions({
        actions: [{
          type: "apply-reviewed-content",
          canonicalPath: target,
          content: reviewed,
          changeSummary: attempt.value(undefined),
        }],
        content: [],
      });
      assert.deepEqual(await readFile(target), reviewed);
      assert.deepEqual(annotated, [
        { type: "text", text: "The user's reviewed file content was applied after Pi's tool call." },
      ]);
    });
    for (const { error, message } of [
      { error: new Error("diff unavailable"), message: "diff unavailable" },
      { error: undefined, message: "undefined" },
    ]) {
      it(`applies reviewed bytes and reports summary failure without replacing the original error (${message})`, async (testContext) => {
        const root = await fixture(testContext);
        const target = join(root, "file.txt");
        const reviewed = Buffer.from("reviewed content\n");
        const changeSummary = attempt.error(error);
        const annotated = await applyFilePostToolActions({
          actions: [{
            type: "apply-reviewed-content",
            canonicalPath: target,
            content: reviewed,
            changeSummary,
          }],
          content: [],
        });
        assert.deepEqual(await readFile(target), reviewed);
        assert.equal(changeSummary.error, error);
        assert.equal(changeSummary.success, false);
        assert.deepEqual(annotated, [
          { type: "text", text: "The user's reviewed file content was applied after Pi's tool call." },
          { type: "text", text: `Review change summary unavailable: ${message}` },
        ]);
      });
    }
    for (const { name, changeSummary } of [
      { name: "generated summary", changeSummary: attempt.value(summary) },
      { name: "summary failure", changeSummary: attempt.error(new Error("diff unavailable")) },
    ]) {
      it(`suppresses the ${name} when application fails while retaining the application error and feedback`, async (testContext) => {
        const root = await fixture(testContext);
        const target = join(root, "file.txt");
        const originalError = new Error("disk unavailable");
        const originalContent = [{ type: "text" as const, text: "Pi's native output" }];
        const annotated = await applyFilePostToolActions({
          actions: [
            {
              type: "apply-reviewed-content",
              canonicalPath: target,
              content: Buffer.from("reviewed content\n"),
              changeSummary,
            },
            { type: "append-user-feedback", feedback: "Keep this change." },
          ],
          content: originalContent,
          async applyReviewedContent() {
            return attempt.error(originalError);
          },
        });
        assert.equal(annotated[0], originalContent[0]);
        assert.deepEqual(annotated.slice(1), [
          { type: "text", text: "The user's reviewed file content could not be applied: disk unavailable" },
          { type: "text", text: "User feedback on approval: Keep this change." },
        ]);
      });
    }
  });

  it("returns original blocks unchanged when no actions exist", async () => {
    const content = [{ type: "text" as const, text: "Original result" }];
    assert.equal(await applyFilePostToolActions({ actions: [], content }), content);
  });
});
