import {
  isPathWithinWorkspace,
  resolveCanonicalPath,
  resolveInputPath,
} from "#/paths/index.ts";
import type {
  WorkspacePathAssessment,
  WorkspacePathAssessmentInput,
  WorkspacePathClassificationInput,
} from "./types.ts";

export async function assessWorkspacePaths({
  requestedPaths,
  workspacePaths,
  cwd,
  homeDirectory,
}: WorkspacePathAssessmentInput): Promise<WorkspacePathAssessment> {
  const canonicalWorkspacePaths: Array<string> = [];
  for (const workspacePath of workspacePaths) {
    const resolution = await resolveCanonicalPath(
      resolveInputPath({ inputPath: workspacePath, cwd, homeDirectory }),
    );
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
    const resolution = await resolveCanonicalPath(
      resolveInputPath({ inputPath: requestedPath, cwd, homeDirectory }),
    );
    if (!resolution.success) {
      return {
        type: "resolution-failed",
        path: requestedPath,
        error: resolution.error,
      };
    }
    canonicalPaths.push(resolution.value);
  }
  const outsidePaths = findOutsideWorkspacePaths({
    paths: canonicalPaths,
    workspacePaths: canonicalWorkspacePaths,
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
