import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPostToolActions,
  createPostToolActionRegistry,
} from "#/post-tool-actions/index.ts";
import { postToolActionMessageTemplates } from "#/post-tool-actions/messages.ts";

describe("post-tool actions", () => {
  describe("post-tool action registry", () => {
    const firstToolCallId = "first-tool-call";
    const secondToolCallId = "second-tool-call";
    const firstAction = {
      type: "append-user-feedback" as const,
      feedback: "Keep the helper small.",
    };
    const secondAction = {
      type: "append-user-feedback" as const,
      feedback: "Preserve the existing names.",
    };
    it("returns actions for a tool call in registration order", () => {
      const registry = createPostToolActionRegistry();
      registry.add({ toolCallId: firstToolCallId, action: firstAction });
      registry.add({ toolCallId: firstToolCallId, action: secondAction });
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), [
        firstAction,
        secondAction,
      ]);
    });
    it("keeps actions isolated by tool-call ID", () => {
      const registry = createPostToolActionRegistry();
      registry.add({ toolCallId: firstToolCallId, action: firstAction });
      registry.add({ toolCallId: secondToolCallId, action: secondAction });
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), [
        firstAction,
      ]);
      assert.deepEqual(registry.takeByToolCallId(secondToolCallId), [
        secondAction,
      ]);
    });
    it("atomically removes actions when they are taken", () => {
      const registry = createPostToolActionRegistry();
      registry.add({ toolCallId: firstToolCallId, action: firstAction });
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), [
        firstAction,
      ]);
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), []);
    });
    it("returns an empty list for an unknown tool call", () => {
      const registry = createPostToolActionRegistry();
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), []);
    });
    it("clears one tool call without affecting another", () => {
      const registry = createPostToolActionRegistry();
      registry.add({ toolCallId: firstToolCallId, action: firstAction });
      registry.add({ toolCallId: secondToolCallId, action: secondAction });
      registry.clearByToolCallId(firstToolCallId);
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), []);
      assert.deepEqual(registry.takeByToolCallId(secondToolCallId), [
        secondAction,
      ]);
    });
    it("clears all actions and remains safe to clear again", () => {
      const registry = createPostToolActionRegistry();
      registry.add({ toolCallId: firstToolCallId, action: firstAction });
      registry.add({ toolCallId: secondToolCallId, action: secondAction });
      registry.clear();
      registry.clear();
      registry.clearByToolCallId(firstToolCallId);
      assert.deepEqual(registry.takeByToolCallId(firstToolCallId), []);
      assert.deepEqual(registry.takeByToolCallId(secondToolCallId), []);
    });
  });
  describe("post-tool action application", () => {
    it("appends acceptance feedback in action order", () => {
      const originalContent = [
        { type: "text" as const, text: "Tool finished." },
      ];
      assert.deepEqual(
        applyPostToolActions({
          actions: [
            { type: "append-user-feedback", feedback: "First note." },
            { type: "append-user-feedback", feedback: "Second note." },
          ],
          content: originalContent,
        }),
        [
          ...originalContent,
          {
            type: "text",
            text: postToolActionMessageTemplates.userFeedback("First note."),
          },
          {
            type: "text",
            text: postToolActionMessageTemplates.userFeedback("Second note."),
          },
        ],
      );
      assert.deepEqual(originalContent, [
        { type: "text", text: "Tool finished." },
      ]);
    });
    it("appends the exact editor-authorized Bash input without altering original result blocks", () => {
      const originalContent = [{ type: "text" as const, text: "Bash failed." }];
      const command = "printf 'edited\\n'";
      assert.deepEqual(
        applyPostToolActions({
          actions: [{ type: "annotate-edited-bash-command", command }],
          content: originalContent,
        }),
        [
          ...originalContent,
          {
            type: "text",
            text: postToolActionMessageTemplates.editedBashCommand(command),
          },
        ],
      );
      assert.deepEqual(originalContent, [{ type: "text", text: "Bash failed." }]);
    });

    it("returns the original content when there are no actions", () => {
      const content = [{ type: "text" as const, text: "Tool finished." }];
      assert.equal(applyPostToolActions({ actions: [], content }), content);
    });
  });
});
