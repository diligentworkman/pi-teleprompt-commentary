import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { attempt } from "#/errors/index.ts";
import { formatSessionArtifactsContext } from "#/session-artifacts/utils.ts";

describe("session artifact context formatting", () => {
  const directoryPath = join(tmpdir(), "teleprompt-artifact-context", "session-123");
  it("announces the available directory with persistence, native-tool, and review guidance", (testContext) => {
    const context = formatSessionArtifactsContext(attempt.value(directoryPath));
    assert.ok(context.includes(`path="${directoryPath}"`));
    testContext.assert.fileSnapshot(
      context,
      join(import.meta.dirname, "snapshots/context-available.txt"),
      { serializers: [(value) => String(value).replaceAll(directoryPath, "SESSION_ARTIFACT_DIRECTORY")] },
    );
  });
  it("announces disabled artifacts without a path and directs plans into the conversation", (testContext) => {
    const context = formatSessionArtifactsContext(attempt.value(undefined));
    assert.doesNotMatch(context, / path=| reason=/);
    testContext.assert.fileSnapshot(
      context,
      join(import.meta.dirname, "snapshots/context-disabled.txt"),
      { serializers: [(value) => String(value)] },
    );
  });
  it("reports an unavailable directory without promising automatic permission or replacing its error", (testContext) => {
    const error = new Error("filesystem permission denied");
    const artifactRoot = attempt.error(error);
    const context = formatSessionArtifactsContext(artifactRoot);
    assert.equal(artifactRoot.error, error);
    assert.doesNotMatch(context, / path=/);
    testContext.assert.fileSnapshot(
      context,
      join(import.meta.dirname, "snapshots/context-unavailable.txt"),
      { serializers: [(value) => String(value)] },
    );
  });
  it("escapes special characters in the directory attribute rather than treating them as markup", () => {
    const specialPath = join(directoryPath, 'notes & "<plan>"');
    const context = formatSessionArtifactsContext(attempt.value(specialPath));
    assert.ok(context.includes('notes &amp; &quot;&lt;plan&gt;&quot;">'));
    assert.doesNotMatch(context, /<plan>/);
  });
  it("escapes error text in the reason attribute rather than treating it as markup", () => {
    const context = formatSessionArtifactsContext(attempt.error(new Error('access & "<denied>"')));
    assert.ok(context.includes('reason="access &amp; &quot;&lt;denied&gt;&quot;"'));
    assert.doesNotMatch(context, /<denied>/);
  });
  it("distinguishes a failure carrying undefined from disabled artifacts", () => {
    const context = formatSessionArtifactsContext(attempt.error(undefined));
    assert.match(context, /availability="unavailable" reason="undefined"/);
    assert.doesNotMatch(context, /availability="disabled"/);
  });
  it("renders a non-Error failure without modifying the original thrown value", () => {
    const error = { reason: "access denied" };
    const artifactRoot = attempt.error(error);
    const context = formatSessionArtifactsContext(artifactRoot);
    assert.match(context, /availability="unavailable" reason="\[object Object\]"/);
    assert.equal(artifactRoot.error, error);
  });
});
