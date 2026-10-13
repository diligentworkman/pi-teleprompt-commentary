import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runRestoredPiFilePreview } from "#/file-preview/restored-preview.ts";
import { createOriginalContentArtifact } from "#/file-review/original-content.ts";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

describe("original-content editor artifact", () => {
  it("contains exact pre-preview bytes while Pi's proposal is present; cleanup cannot affect restoration", async (testContext) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-original-content-")));
    testContext.after(async () => rm(root, { recursive: true, force: true }));
    const store = createRuntimeTemporaryFileStore({ temporaryRootPath: root, createFileId: () => "original" });
    testContext.after(async () => store.cleanup());
    const target = join(root, "target.txt");
    const original = Buffer.from([0, 255, 10]);
    await writeFile(target, original);
    const result = await runRestoredPiFilePreview({
      canonicalPath: target,
      preview: { toolName: "write", input: { path: target, content: "proposal" } },
      toolCallId: "original-artifact",
      ctx: { cwd: root } as ExtensionContext,
      async inspectProposal(snapshot) {
        const artifact = await createOriginalContentArtifact({ snapshot, temporaryFileStore: store });
        assert.equal(artifact.success, true);
        if (!artifact.success || artifact.value === undefined) assert.fail("Expected existing-file artifact.");
        assert.deepEqual(await readFile(artifact.value.path), original);
        assert.equal(await readFile(target, "utf8"), "proposal");
        await artifact.value.cleanup();
      },
    });
    assert.deepEqual(result, { type: "previewed" });
    assert.deepEqual(await readFile(target), original);
  });
});
