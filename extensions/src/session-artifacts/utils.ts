import { attempt, getErrorMessage, isErrorWithCode, type AttemptResult } from "#/errors/index.ts";
import { resolveCanonicalPath } from "#/paths/index.ts";
import { lstat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { contextMessages, errorMessages } from "./messages.ts";

type SessionArtifactsPathInput = {
  agentDirectoryPath: string;
  sessionId: string;
  sessionFilePath: string | undefined;
};

export function resolveSessionArtifactsPath({
  agentDirectoryPath,
  sessionId,
  sessionFilePath,
}: SessionArtifactsPathInput): AttemptResult<string | undefined> {
  return attempt.sync(() => {
    if (sessionFilePath === undefined) {
      return undefined;
    }
    const artifactsRootPath = resolve(
      agentDirectoryPath,
      "teleprompt-commentary",
      "artifacts",
    );
    const directoryPath = resolve(artifactsRootPath, sessionId);
    // Require one unchanged child name, not Pi's current session-ID format.
    if (
      sessionId.includes("\0") ||
      dirname(directoryPath) !== artifactsRootPath ||
      relative(artifactsRootPath, directoryPath) !== sessionId
    ) {
      throw new Error(errorMessages.unsafeSessionId);
    }

    return directoryPath;
  });
}

export async function resolveSessionArtifactsAccessRoot(
  input: SessionArtifactsPathInput,
): Promise<AttemptResult<string | undefined>> {
  const artifactPath = resolveSessionArtifactsPath(input);
  if (!artifactPath.success || artifactPath.value === undefined) {
    return artifactPath;
  }
  const agentDirectoryPath = resolve(input.agentDirectoryPath);
  const canonicalAgentDirectory = await resolveCanonicalPath(agentDirectoryPath);
  if (!canonicalAgentDirectory.success) {
    return canonicalAgentDirectory;
  }
  const expectedPath = resolve(
    canonicalAgentDirectory.value,
    relative(agentDirectoryPath, artifactPath.value),
  );
  const canonicalArtifactsPath = await resolveCanonicalPath(artifactPath.value);
  if (!canonicalArtifactsPath.success) {
    return canonicalArtifactsPath;
  }
  // Trust the configured agent root, but not redirects below it into another session or location.
  if (canonicalArtifactsPath.value !== expectedPath) {
    return attempt.error(new Error(errorMessages.redirectedArtifactsDirectory));
  }
  const entry = await attempt(() => lstat(canonicalArtifactsPath.value));
  if (!entry.success) {
    if (!isErrorWithCode({ error: entry.error, code: "ENOENT" })) {
      return entry;
    }
  } else if (!entry.value.isDirectory()) {
    return attempt.error(new Error(errorMessages.artifactsPathNotDirectory));
  }

  return canonicalArtifactsPath;
}

export function formatSessionArtifactsContext(
  artifactRoot: AttemptResult<string | undefined>,
): string {
  const detail = artifactRoot.success ? artifactRoot.value : getErrorMessage(artifactRoot.error);
  const escapedDetail = detail
    ?.replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (!artifactRoot.success) {
    return `<teleprompt_commentary_session_artifacts availability="unavailable" reason="${escapedDetail}">
${contextMessages.unavailable}
</teleprompt_commentary_session_artifacts>`;
  }
  if (artifactRoot.value === undefined) {
    return `<teleprompt_commentary_session_artifacts availability="disabled">
${contextMessages.disabled}
</teleprompt_commentary_session_artifacts>`;
  }

  return `<teleprompt_commentary_session_artifacts availability="available" path="${escapedDetail}">
${contextMessages.available.join("\n")}
</teleprompt_commentary_session_artifacts>`;
}
