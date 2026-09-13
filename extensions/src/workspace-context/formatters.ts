import type {
  WorkspaceContextFormattingInput,
  WorkspaceContextSource,
  WorkspaceContextSourceSelection,
  WorkspaceContextStatus,
} from "./types.ts";

const workspaceContextTemplates = {
  boundaryGuidance:
    "File tools may access the primary workspace and explicitly configured additional workspaces without additional permission.",
  outsidePathGuidance:
    "File-tool calls targeting paths outside those workspaces may still be attempted; the extension will request interactive permission before execution. Do not treat outside paths as categorically forbidden.",
  bashGuidance:
    "The bash tool is not workspace-gated. Use it only with paths inside the configured workspace boundaries.",
  samePathGuidance:
    "Do not issue parallel write or edit operations that target the same path.",
  snapshotGuidance:
    "Context source contents below are a snapshot read before this agent run. Changes to those files apply on the next agent run.",
  primaryWorkspaceAvailable:
    "Pi owns resource and instruction loading for this primary workspace.",
  primaryWorkspaceUnavailable:
    "This primary workspace is unavailable. Do not assume its files can be accessed.",
  additionalWorkspaceUnavailable:
    "This additional workspace is unavailable. Do not assume its files can be accessed.",
  noAdditionalWorkspaceContext:
    "No additional workspace context sources were loaded.",
} as const;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatWorkspaceAttributes({
  role,
  status,
}: {
  role: "primary" | "additional";
  status: WorkspaceContextStatus;
}): string {
  const attributes = [
    `role="${role}"`,
    `path="${escapeAttribute(status.workspacePath)}"`,
    `availability="${status.availability}"`,
  ];
  if (status.availability === "unavailable") {
    attributes.push(`reason="${escapeAttribute(status.reason)}"`);
  }

  return attributes.join(" ");
}

function formatContextSource(source: WorkspaceContextSource): string {
  const elementName =
    source.kind === "instructions"
      ? "workspace_instructions"
      : "workspace_system_prompt_append";
  return `<${elementName} path="${escapeAttribute(source.sourcePath)}">
${source.content}
</${elementName}>`;
}

function formatPrimaryWorkspace(status: WorkspaceContextStatus): string {
  const attributes = formatWorkspaceAttributes({ role: "primary", status });
  const description =
    status.availability === "available"
      ? workspaceContextTemplates.primaryWorkspaceAvailable
      : workspaceContextTemplates.primaryWorkspaceUnavailable;

  return `<workspace ${attributes}>
${description}
</workspace>`;
}

function formatAdditionalWorkspace({
  selection,
  contextSources,
}: {
  selection: WorkspaceContextSourceSelection;
  contextSources: ReadonlyArray<WorkspaceContextSource>;
}): string {
  const attributes = formatWorkspaceAttributes({
    role: "additional",
    status: selection,
  });
  if (selection.availability === "unavailable") {
    return `<workspace ${attributes}>
${workspaceContextTemplates.additionalWorkspaceUnavailable}
</workspace>`;
  }
  const workspaceSources = contextSources.filter((source) => {
    return source.workspacePath === selection.workspacePath;
  });
  const orderedSources = [
    ...workspaceSources.filter((source) => {
      return source.kind === "system-prompt-append";
    }),
    ...workspaceSources.filter((source) => {
      return source.kind === "instructions";
    }),
  ];
  if (orderedSources.length === 0) {
    return `<workspace ${attributes}>
${workspaceContextTemplates.noAdditionalWorkspaceContext}
</workspace>`;
  }

  return `<workspace ${attributes}>
${orderedSources.map(formatContextSource).join("\n\n")}
</workspace>`;
}

export function formatWorkspaceContext({
  primaryWorkspaceStatus,
  additionalWorkspaceSelections,
  contextSources,
}: WorkspaceContextFormattingInput): string {
  const workspaces = [
    formatPrimaryWorkspace(primaryWorkspaceStatus),
    ...additionalWorkspaceSelections.map((selection) => {
      return formatAdditionalWorkspace({ selection, contextSources });
    }),
  ];
  const guidance = [
    workspaceContextTemplates.boundaryGuidance,
    workspaceContextTemplates.outsidePathGuidance,
    workspaceContextTemplates.bashGuidance,
    workspaceContextTemplates.samePathGuidance,
    workspaceContextTemplates.snapshotGuidance,
  ].join("\n");

  return `<teleprompt_commentary_workspace_context>

${guidance}

${workspaces.join("\n\n")}

</teleprompt_commentary_workspace_context>`;
}
