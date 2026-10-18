import { attempt } from "#/errors/index.ts";
import {
  isPathWithinWorkspace,
  resolveCanonicalPath,
  resolveInputPath,
  resolveReadCandidate,
} from "#/paths/index.ts";
import type {
  WorkspacePathAssessment,
  WorkspacePathAssessmentInput,
  WorkspacePathClassificationInput,
} from "./types.ts";

export async function assessWorkspacePaths({
  requestedPaths,
  toolName,
  workspacePaths,
  sessionArtifactsRoot,
  cwd,
  homeDirectory,
}: WorkspacePathAssessmentInput): Promise<WorkspacePathAssessment> {
  const canonicalWorkspacePaths: Array<string> = [];
  for (const workspacePath of workspacePaths) {
    // Workspace roots are resolved filesystem paths, not Pi tool inputs.
    const resolution = await resolveCanonicalPath(workspacePath);
    if (!resolution.success) {
      return {
        type: "resolution-failed",
        path: workspacePath,
        error: resolution.error,
      };
    }
    canonicalWorkspacePaths.push(resolution.value);
  }
  const canonicalPaths: Array<string> = [];
  for (const requestedPath of requestedPaths) {
    const normalized = attempt.sync(() => resolveInputPath({ inputPath: requestedPath, cwd, homeDirectory }));
    const resolution = normalized.success
      ? await resolveCanonicalPath(toolName === "read" ? await resolveReadCandidate(normalized.value) : normalized.value)
      : normalized;
    if (!resolution.success) {
      return {
        type: "resolution-failed",
        path: requestedPath,
        error: resolution.error,
      };
    }
    canonicalPaths.push(resolution.value);
  }
  // Keep the validated artifact root fixed; resolving it again could trust a replacement symlink.
  const permittedRoots = sessionArtifactsRoot === undefined
    ? canonicalWorkspacePaths
    : [...canonicalWorkspacePaths, sessionArtifactsRoot];
  const outsidePaths = findOutsideWorkspacePaths({
    paths: canonicalPaths,
    workspacePaths: permittedRoots,
  });
  if (outsidePaths.length === 0) {
    return { type: "inside", canonicalPaths };
  }

  return { type: "outside", canonicalPaths, outsidePaths };
}

export function findOutsideWorkspacePaths({
  paths,
  workspacePaths,
}: WorkspacePathClassificationInput): Array<string> {
  return paths.filter((path) => {
    return !workspacePaths.some((workspacePath) => {
      return isPathWithinWorkspace({ path, workspacePath });
    });
  });
}
