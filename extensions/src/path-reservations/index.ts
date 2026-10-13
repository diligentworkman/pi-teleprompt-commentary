import type {
  AcquirePathReservationInput,
  PathReservationAcquisitionOutcome,
  PathReservationRegistry,
} from "./types.ts";

export { pathReservationBlockMessageTemplates } from "./messages.ts";

export function createPathReservationRegistry(): PathReservationRegistry {
  const ownerToolCallIdByCanonicalPath = new Map<string, string>();
  const canonicalPathsByToolCallId = new Map<string, Set<string>>();

  return {
    acquire({
      canonicalPath,
      toolCallId,
    }: AcquirePathReservationInput): PathReservationAcquisitionOutcome {
      const currentOwnerToolCallId =
        ownerToolCallIdByCanonicalPath.get(canonicalPath);
      if (
        currentOwnerToolCallId !== undefined &&
        currentOwnerToolCallId !== toolCallId
      ) {
        return {
          type: "conflict",
          canonicalPath,
          currentOwnerToolCallId,
        };
      }
      if (currentOwnerToolCallId === undefined) {
        ownerToolCallIdByCanonicalPath.set(canonicalPath, toolCallId);
        const canonicalPaths =
          canonicalPathsByToolCallId.get(toolCallId) ?? new Set<string>();
        canonicalPaths.add(canonicalPath);
        canonicalPathsByToolCallId.set(toolCallId, canonicalPaths);
      }

      return { type: "acquired" };
    },
    releaseByToolCallId(toolCallId) {
      const canonicalPaths = canonicalPathsByToolCallId.get(toolCallId);
      if (canonicalPaths === undefined) {
        return;
      }
      for (const canonicalPath of canonicalPaths) {
        if (ownerToolCallIdByCanonicalPath.get(canonicalPath) === toolCallId) {
          ownerToolCallIdByCanonicalPath.delete(canonicalPath);
        }
      }
      canonicalPathsByToolCallId.delete(toolCallId);
    },
    clear() {
      ownerToolCallIdByCanonicalPath.clear();
      canonicalPathsByToolCallId.clear();
    },
  };
}
