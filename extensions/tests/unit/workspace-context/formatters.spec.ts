import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatWorkspaceContext } from "#/workspace-context/formatters.ts";

describe("workspace context formatting", () => {
  it("formats workspace boundaries and attributed sources in semantic order", (testContext) => {
    const primaryWorkspacePath = "/workspaces/primary";
    const additionalWorkspacePath = "/workspaces/additional";
    const instructionPath = `${additionalWorkspacePath}/AGENTS.md`;
    const systemPromptAppendPath = `${additionalWorkspacePath}/.pi/APPEND_SYSTEM.md`;
    const formattedContext = formatWorkspaceContext({
      primaryWorkspaceStatus: {
        workspacePath: primaryWorkspacePath,
        availability: "available",
      },
      additionalWorkspaceSelections: [
        {
          workspacePath: additionalWorkspacePath,
          availability: "available",
          instructionPath,
          systemPromptAppendPath,
        },
      ],
      contextSources: [
        {
          kind: "instructions",
          workspacePath: additionalWorkspacePath,
          sourcePath: instructionPath,
          content: "Follow the additional workspace rules.\n",
        },
        {
          kind: "system-prompt-append",
          workspacePath: additionalWorkspacePath,
          sourcePath: systemPromptAppendPath,
          content: "Use the additional workspace terminology.\n",
        },
      ],
    });
    testContext.assert.fileSnapshot(
      formattedContext,
      join(import.meta.dirname, "snapshots/workspace-context.txt"),
      { serializers: [(value) => String(value)] },
    );
  });
  it("identifies unavailable workspaces and escapes attributed values", () => {
    const formattedContext = formatWorkspaceContext({
      primaryWorkspaceStatus: {
        workspacePath: '/workspaces/primary & "missing"',
        availability: "unavailable",
        reason: "path <does> not exist",
      },
      additionalWorkspaceSelections: [
        {
          workspacePath: "/workspaces/additional",
          availability: "unavailable",
          reason: "permission denied",
        },
      ],
      contextSources: [],
    });
    assert.match(
      formattedContext,
      /<workspace role="primary" path="\/workspaces\/primary &amp; &quot;missing&quot;" availability="unavailable" reason="path &lt;does&gt; not exist">/,
    );
    assert.match(
      formattedContext,
      /This primary workspace is unavailable\. Do not assume its files can be accessed\./,
    );
    assert.match(
      formattedContext,
      /<workspace role="additional" path="\/workspaces\/additional" availability="unavailable" reason="permission denied">/,
    );
    assert.match(
      formattedContext,
      /This additional workspace is unavailable\. Do not assume its files can be accessed\./,
    );
  });
  it("preserves empty source content and reports an available workspace without sources", () => {
    const firstWorkspace = "/workspaces/first";
    const secondWorkspace = "/workspaces/second";
    const instructionPath = `${firstWorkspace}/CLAUDE.md`;
    const formattedContext = formatWorkspaceContext({
      primaryWorkspaceStatus: {
        workspacePath: "/workspaces/primary",
        availability: "available",
      },
      additionalWorkspaceSelections: [
        {
          workspacePath: firstWorkspace,
          availability: "available",
          instructionPath,
        },
        {
          workspacePath: secondWorkspace,
          availability: "available",
        },
      ],
      contextSources: [
        {
          kind: "instructions",
          workspacePath: firstWorkspace,
          sourcePath: instructionPath,
          content: "",
        },
      ],
    });
    assert.match(
      formattedContext,
      /<workspace_instructions path="\/workspaces\/first\/CLAUDE\.md">\n\n<\/workspace_instructions>/,
    );
    assert.match(
      formattedContext,
      /<workspace role="additional" path="\/workspaces\/second" availability="available">\nNo additional workspace context sources were loaded\.\n<\/workspace>/,
    );
  });
});
