import { diffLines } from "diff";

export function summarizeFileReviewChanges({
  proposal,
  reviewed,
}: {
  proposal: string;
  reviewed: string;
}): string | undefined {
  const changes = diffLines(proposal, reviewed);
  const descriptions: Array<string> = [];
  let proposalLine = 1;
  let reviewedLine = 1;
  let index = 0;
  while (index < changes.length) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      proposalLine += change.count;
      reviewedLine += change.count;
      index += 1;
      continue;
    }
    const proposalStart = proposalLine;
    const reviewedStart = reviewedLine;
    // Adjacent removals and additions describe one replacement region.
    while (index < changes.length) {
      const changed = changes[index]!;
      if (!changed.added && !changed.removed) {
        break;
      }
      if (changed.removed) {
        proposalLine += changed.count;
      }
      if (changed.added) {
        reviewedLine += changed.count;
      }
      index += 1;
    }
    const removed = proposalLine - proposalStart;
    const added = reviewedLine - reviewedStart;
    const proposalRange = removed <= 1
      ? `proposal line ${proposalStart}`
      : `proposal lines ${proposalStart}–${proposalLine - 1}`;
    const reviewedRange = added <= 1
      ? `reviewed line ${reviewedStart}`
      : `reviewed lines ${reviewedStart}–${reviewedLine - 1}`;
    if (removed > 0 && added > 0) {
      descriptions.push(`- Modified: ${proposalRange} → ${reviewedRange}`);
    } else if (added > 0) {
      descriptions.push(`- Inserted: ${reviewedRange}`);
    } else {
      const location = reviewed.length === 0
        ? "reviewed content is empty"
        : reviewedStart === 1
          ? "before reviewed line 1"
          : `after reviewed line ${reviewedStart - 1}`;
      descriptions.push(`- Deleted: ${proposalRange}; ${location}`);
    }
  }

  return descriptions.length === 0
    ? undefined
    : [
        "User review changes (agent proposal → reviewed content; line numbers refer to those versions):",
        ...descriptions,
      ].join("\n");
}
