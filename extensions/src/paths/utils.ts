import {
  attempt,
  isErrorWithCode,
  type AttemptResult,
} from "#/errors/index.ts";
import {
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function extractToolPaths({
  event,
  cwd,
}: {
  event: ToolCallEvent;
  cwd: string;
}): Array<string> {
  if (isToolCallEventType("read", event)) {
    return [event.input.path];
  }
  if (isToolCallEventType("write", event)) {
    return [event.input.path];
  }
  if (isToolCallEventType("edit", event)) {
    return [event.input.path];
  }
  if (isToolCallEventType("grep", event)) {
    return [event.input.path ?? cwd];
  }
  if (isToolCallEventType("find", event)) {
    return [event.input.path ?? cwd];
  }
  if (isToolCallEventType("ls", event)) {
    return [event.input.path ?? cwd];
  }

  return [];
}

export function resolveInputPath({
  inputPath,
  cwd,
  homeDirectory,
}: {
  inputPath: string;
  cwd: string;
  homeDirectory: string;
}) {
  let path = inputPath;
  if (path.startsWith("@")) {
    path = path.slice(1);
  }
  if (path === "~") {
    path = homeDirectory;
  } else if (
    path.startsWith("~/") ||
    (sep === "\\" && path.startsWith("~\\"))
  ) {
    path = join(homeDirectory, path.slice(2));
  }

  return resolve(cwd, path);
}

export async function resolveCanonicalPath(
  path: string,
): Promise<AttemptResult<string>> {
  const missingPathSegments: Array<string> = [];
  let candidatePath = path;
  while (true) {
    const resolution = await attempt(() => realpath(candidatePath));
    if (resolution.success) {
      return attempt.value(join(resolution.value, ...missingPathSegments));
    }
    const pathIsMissing =
      isErrorWithCode({ error: resolution.error, code: "ENOENT" }) ||
      isErrorWithCode({ error: resolution.error, code: "ENOTDIR" });
    if (!pathIsMissing) {
      return attempt.error(resolution.error);
    }
    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      return attempt.error(resolution.error);
    }
    missingPathSegments.unshift(basename(candidatePath));
    candidatePath = parentPath;
  }
}

export function isPathWithinWorkspace({
  path,
  workspacePath,
}: {
  path: string;
  workspacePath: string;
}): boolean {
  const relativePath = relative(workspacePath, path);
  if (relativePath === "") {
    return true;
  }

  const traversesOutsideWorkspace =
    relativePath === ".." || relativePath.startsWith(`..${sep}`);
  const belongsToAnotherFileSystemRoot = isAbsolute(relativePath);

  return !traversesOutsideWorkspace && !belongsToAnotherFileSystemRoot;
}
