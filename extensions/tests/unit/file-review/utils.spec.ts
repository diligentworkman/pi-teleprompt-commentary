import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { summarizeFileReviewChanges } from "#/file-review/utils.ts";

describe("file review change summaries", () => {
  const heading = "User review changes (agent proposal → reviewed content; line numbers refer to those versions):";
  describe("when reviewed content matches the agent proposal", () => {
    for (const content of ["", "one", "one\ntwo\n", "one\r\ntwo\r\n"]) {
      it(`omits the summary for identical content ${JSON.stringify(content)}`, () => {
        assert.equal(summarizeFileReviewChanges({ proposal: content, reviewed: content }), undefined);
      });
    }
  });
  describe("when the user changes the agent proposal", () => {
    it("renders multiple insertions, modifications, and deletions in file order with shifted line numbers", (testContext) => {
      const proposal = [
        "start",
        "keep-a",
        "old-first-a",
        "old-first-b",
        "keep-b",
        "remove-first",
        "keep-c",
        "keep-d",
        "old-second",
        "keep-e",
        "remove-second-a",
        "remove-second-b",
        "keep-f",
        "",
      ].join("\n");
      const reviewed = [
        "intro-first",
        "intro-second",
        "start",
        "keep-a",
        "replacement-first",
        "keep-b",
        "keep-c",
        "inserted-middle",
        "keep-d",
        "replacement-second-a",
        "replacement-second-b",
        "keep-e",
        "keep-f",
        "",
      ].join("\n");
      const summary = summarizeFileReviewChanges({ proposal, reviewed });
      testContext.assert.fileSnapshot(
        summary,
        join(import.meta.dirname, "snapshots/review-changes.txt"),
        { serializers: [(value) => String(value)] },
      );
    });
    const cases = [
      {
        name: "reports every inserted line when an empty proposal receives content",
        proposal: "",
        reviewed: "one\ntwo\n",
        descriptions: ["- Inserted: reviewed lines 1–2"],
      },
      {
        name: "reports insertion at the beginning using reviewed line numbers",
        proposal: "one\ntwo\n",
        reviewed: "intro\none\ntwo\n",
        descriptions: ["- Inserted: reviewed line 1"],
      },
      {
        name: "reports insertion in the middle using reviewed line numbers",
        proposal: "one\nthree\n",
        reviewed: "one\ntwo\nthree\n",
        descriptions: ["- Inserted: reviewed line 2"],
      },
      {
        name: "reports insertion after the last proposal line",
        proposal: "one\n",
        reviewed: "one\ntwo\nthree\n",
        descriptions: ["- Inserted: reviewed lines 2–3"],
      },
      {
        name: "anchors deletion at the beginning before the first reviewed line",
        proposal: "intro\none\ntwo\n",
        reviewed: "one\ntwo\n",
        descriptions: ["- Deleted: proposal line 1; before reviewed line 1"],
      },
      {
        name: "anchors deletion in the middle after the preceding reviewed line",
        proposal: "one\ntwo\nthree\nfour\n",
        reviewed: "one\nfour\n",
        descriptions: ["- Deleted: proposal lines 2–3; after reviewed line 1"],
      },
      {
        name: "anchors deletion at the end after the last reviewed line",
        proposal: "one\ntwo\nthree\n",
        reviewed: "one\n",
        descriptions: ["- Deleted: proposal lines 2–3; after reviewed line 1"],
      },
      {
        name: "reports an emptied file without pointing to a nonexistent reviewed line",
        proposal: "one\ntwo\n",
        reviewed: "",
        descriptions: ["- Deleted: proposal lines 1–2; reviewed content is empty"],
      },
      {
        name: "groups adjacent removal and insertion as a replacement with both line ranges",
        proposal: "one\ntwo\nthree\nfour\n",
        reviewed: "one\nnew\nfour\n",
        descriptions: ["- Modified: proposal lines 2–3 → reviewed line 2"],
      },
      {
        name: "tracks independent proposal and reviewed offsets across separated changes",
        proposal: "one\ntwo\nthree\nfour\nfive\n",
        reviewed: "intro\none\nTWO\nextra\nthree\nfive\ntail\n",
        descriptions: [
          "- Inserted: reviewed line 1",
          "- Modified: proposal line 2 → reviewed lines 3–4",
          "- Deleted: proposal line 4; after reviewed line 5",
          "- Inserted: reviewed line 7",
        ],
      },
      {
        name: "counts CRLF lines once when locating changed content",
        proposal: "one\r\ntwo\r\n",
        reviewed: "one\r\nTWO\r\n",
        descriptions: ["- Modified: proposal line 2 → reviewed line 2"],
      },
      {
        name: "reports line-ending changes rather than silently ignoring them",
        proposal: "one\r\n",
        reviewed: "one\n",
        descriptions: ["- Modified: proposal line 1 → reviewed line 1"],
      },
      {
        name: "reports whitespace-only edits as modifications",
        proposal: "one\n",
        reviewed: "  one\n",
        descriptions: ["- Modified: proposal line 1 → reviewed line 1"],
      },
      {
        name: "reports adding a final newline as modification of the final line",
        proposal: "one",
        reviewed: "one\n",
        descriptions: ["- Modified: proposal line 1 → reviewed line 1"],
      },
      {
        name: "reports removing a final newline as modification of the final line",
        proposal: "one\n",
        reviewed: "one",
        descriptions: ["- Modified: proposal line 1 → reviewed line 1"],
      },
      {
        name: "counts an inserted blank line as one reviewed line",
        proposal: "one\ntwo\n",
        reviewed: "one\n\ntwo\n",
        descriptions: ["- Inserted: reviewed line 2"],
      },
    ];
    for (const { name, proposal, reviewed, descriptions } of cases) {
      it(name, () => {
        assert.equal(
          summarizeFileReviewChanges({ proposal, reviewed }),
          [heading, ...descriptions].join("\n"),
        );
      });
    }
  });
});
