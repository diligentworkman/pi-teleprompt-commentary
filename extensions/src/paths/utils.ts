import {
  attempt,
  isErrorWithCode,
  type AttemptResult,
} from "#/errors/index.ts";
import {
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { access, lstat, readlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
  // Match Pi's local resolveToCwd semantics without importing private APIs.
  const normalizedInput = inputPath
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/^@/, "");
  return resolve(
    normalizeLocalPath({ path: cwd, homeDirectory }),
    normalizeLocalPath({ path: normalizedInput, homeDirectory }),
  );
}

function normalizeLocalPath({ path, homeDirectory }: {
  path: string;
  homeDirectory: string;
}): string {
  let normalized = path;
  if (process.platform === "win32" && !path.startsWith("//") && !path.includes("\\")) {
    const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive !== null) {
      normalized = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
    }
  }
  if (normalized === "~") {
    return homeDirectory;
  }
  if (normalized.startsWith("~/") || (sep === "\\" && normalized.startsWith("~\\"))) {
    return join(homeDirectory, normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

export async function resolveReadCandidate(path: string): Promise<string> {
  const decomposedPath = path.normalize("NFD");
  const candidates = [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202F$1."),
    decomposedPath,
    path.replace(/'/g, "\u2019"),
    decomposedPath.replace(/'/g, "\u2019"),
  ];
  // Match Pi's ordered read fallbacks and its F_OK existence checks.
  for (const candidate of new Set(candidates)) {
    const existence = await attempt(() => access(candidate));
    if (existence.success) {
      return candidate;
    }
  }

  return path;
}

export async function resolveCanonicalPath(
  path: string,
): Promise<AttemptResult<string>> {
  const missingPathSegments: Array<string> = [];
  let candidatePath = path;
  while (true) {
    const candidateAttempt = await attempt(() => lstat(candidatePath));
    if (candidateAttempt.success) {
      if (candidateAttempt.value.isSymbolicLink()) {
        const symlinkResolutionAttempt = await attempt(() =>
          realpath(candidatePath),
        );
        if (symlinkResolutionAttempt.success) {
          return attempt.value(
            join(symlinkResolutionAttempt.value, ...missingPathSegments),
          );
        }
        if (
          !isErrorWithCode({
            error: symlinkResolutionAttempt.error,
            code: "ENOENT",
          })
        ) {
          return attempt.error(symlinkResolutionAttempt.error);
        }
        const linkTargetAttempt = await attempt(() => readlink(candidatePath));
        if (!linkTargetAttempt.success) {
          return attempt.error(linkTargetAttempt.error);
        }
        const targetPath = resolve(
          dirname(candidatePath),
          linkTargetAttempt.value,
        );

        return resolveCanonicalPath(join(targetPath, ...missingPathSegments));
      }
      const resolutionAttempt = await attempt(() => realpath(candidatePath));
      if (!resolutionAttempt.success) {
        return attempt.error(resolutionAttempt.error);
      }

      return attempt.value(
        join(resolutionAttempt.value, ...missingPathSegments),
      );
    }
    if (!isErrorWithCode({ error: candidateAttempt.error, code: "ENOENT" })) {
      return attempt.error(candidateAttempt.error);
    }
    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      return attempt.error(candidateAttempt.error);
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
