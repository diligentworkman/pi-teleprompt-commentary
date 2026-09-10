import { join, resolve, sep } from "node:path";

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
