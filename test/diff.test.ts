import { describe, it, expect } from "vitest";
import {
  blockFingerprint,
  needsUpdate,
  propertiesChanged,
  matchBlocks,
  transplantCommentMarks,
  mergeCommentMarks,
} from "../src/lib/diff.js";
import type { BlockRecord } from "../src/lib/blocks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textBlock(text: string, id = "id"): BlockRecord {
  return { id, type: "text", properties: { title: [[text]] } };
}

function headerBlock(text: string, id = "id"): BlockRecord {
  return { id, type: "header", properties: { title: [[text]] } };
}

// ---------------------------------------------------------------------------
// blockFingerprint
// ---------------------------------------------------------------------------

describe("blockFingerprint", () => {
  it("matches identical plain text blocks", () => {
    const a = textBlock("hello");
    const b = textBlock("hello");
    expect(blockFingerprint(a)).toBe(blockFingerprint(b));
  });

  it("differs when text differs", () => {
    expect(blockFingerprint(textBlock("hello"))).not.toBe(
      blockFingerprint(textBlock("world")),
    );
  });

  it("differs when type differs", () => {
    expect(blockFingerprint(textBlock("hello"))).not.toBe(
      blockFingerprint(headerBlock("hello")),
    );
  });

  it("ignores formatting differences", () => {
    const plain: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["hello"]] },
    };
    const bold: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["hello", [["b"]]]] },
    };
    expect(blockFingerprint(plain)).toBe(blockFingerprint(bold));
  });

  it("ignores extra Notion format fields", () => {
    const notion: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["hi"]] },
      format: { block_color: "gray" },
    };
    const md: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["hi"]] },
    };
    expect(blockFingerprint(notion)).toBe(blockFingerprint(md));
  });
});

// ---------------------------------------------------------------------------
// needsUpdate / propertiesChanged
// ---------------------------------------------------------------------------

describe("needsUpdate", () => {
  it("returns false for identical blocks", () => {
    const old = textBlock("hello");
    const neu = textBlock("hello");
    expect(needsUpdate(old, neu)).toBe(false);
  });

  it("returns true when text changes", () => {
    expect(needsUpdate(textBlock("hello"), textBlock("world"))).toBe(true);
  });

  it("returns true when type changes", () => {
    expect(needsUpdate(textBlock("x"), headerBlock("x"))).toBe(true);
  });

  it("ignores Notion comment marks on unchanged text", () => {
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["hello", [["m", "disc-1"]]]] },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["hello"]] },
    };
    expect(needsUpdate(old, neu)).toBe(false);
  });

  it("ignores comment marks that split text", () => {
    // Notion splits: "Hello world" → ["Hello", [["m","d"]]] + [" world"]
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["Hello", [["m", "d"]]], [" world"]] },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["Hello world"]] },
    };
    expect(needsUpdate(old, neu)).toBe(false);
  });

  it("ignores color marks that split text", () => {
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["Hello", [["h", "gray"]]], [" world"]] },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["Hello world"]] },
    };
    expect(needsUpdate(old, neu)).toBe(false);
  });

  it("detects change even with comment marks present", () => {
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["Hello", [["m", "d"]]], [" world"]] },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["Goodbye world"]] },
    };
    expect(needsUpdate(old, neu)).toBe(true);
  });

  it("returns false when only extra Notion format differs", () => {
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["hi"]] },
      format: { block_color: "gray" },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["hi"]] },
    };
    expect(needsUpdate(old, neu)).toBe(false);
  });

  it("preserves bold formatting in comparison", () => {
    const old: BlockRecord = {
      id: "a",
      type: "text",
      properties: { title: [["hello", [["b"]]]] },
    };
    const neu: BlockRecord = {
      id: "b",
      type: "text",
      properties: { title: [["hello"]] },
    };
    // Bold was removed → needs update
    expect(needsUpdate(old, neu)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchBlocks
// ---------------------------------------------------------------------------

describe("matchBlocks", () => {
  it("matches identical block sequences", () => {
    const old = [textBlock("a", "1"), textBlock("b", "2")];
    const neu = [textBlock("a", "x"), textBlock("b", "y")];
    const result = matchBlocks(old, neu);
    expect(result.matched).toContainEqual([0, 0]);
    expect(result.matched).toContainEqual([1, 1]);
    expect(result.deletions).toEqual([]);
    expect(result.insertions).toEqual([]);
  });

  it("detects insertions", () => {
    const old = [textBlock("a", "1")];
    const neu = [textBlock("a", "x"), textBlock("b", "y")];
    const result = matchBlocks(old, neu);
    expect(result.matched).toContainEqual([0, 0]);
    expect(result.insertions).toEqual([1]);
    expect(result.deletions).toEqual([]);
  });

  it("detects deletions", () => {
    const old = [textBlock("a", "1"), textBlock("b", "2")];
    const neu = [textBlock("a", "x")];
    const result = matchBlocks(old, neu);
    expect(result.matched).toContainEqual([0, 0]);
    expect(result.deletions).toEqual([1]);
    expect(result.insertions).toEqual([]);
  });

  it("matches edited blocks by type + position (phase 2)", () => {
    const old = [textBlock("hello", "1"), textBlock("world", "2")];
    const neu = [textBlock("hallo", "x"), textBlock("world", "y")];
    const result = matchBlocks(old, neu);
    // "world" matches exactly, "hello"→"hallo" matched by type+position
    expect(result.matched).toHaveLength(2);
    expect(result.deletions).toEqual([]);
    expect(result.insertions).toEqual([]);
  });

  it("handles reordering", () => {
    const old = [textBlock("a", "1"), textBlock("b", "2"), textBlock("c", "3")];
    const neu = [textBlock("c", "x"), textBlock("a", "y"), textBlock("b", "z")];
    const result = matchBlocks(old, neu);
    // LCS should find at least "a","b" in common subsequence
    expect(result.matched.length).toBeGreaterThanOrEqual(2);
    expect(result.deletions).toEqual([]);
    expect(result.insertions).toEqual([]);
  });

  it("handles empty old list", () => {
    const result = matchBlocks([], [textBlock("a")]);
    expect(result.matched).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.insertions).toEqual([0]);
  });

  it("handles empty new list", () => {
    const result = matchBlocks([textBlock("a", "1")], []);
    expect(result.matched).toEqual([]);
    expect(result.deletions).toEqual([0]);
    expect(result.insertions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transplantCommentMarks
// ---------------------------------------------------------------------------

describe("transplantCommentMarks", () => {
  it("returns new title unchanged when no marks exist", () => {
    const oldTitle: unknown[][] = [["Hello world"]];
    const newTitle: unknown[][] = [["Hello world"]];
    expect(transplantCommentMarks(oldTitle, newTitle)).toEqual(newTitle);
  });

  it("transplants mark when commented text is unchanged", () => {
    // "Hello" has a comment, text unchanged
    const oldTitle: unknown[][] = [["Hello", [["m", "disc-1"]]], [" world"]];
    const newTitle: unknown[][] = [["Hello world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    // "Hello" should get the ["m","disc-1"] mark
    expect(result).toEqual([["Hello", [["m", "disc-1"]]], [" world"]]);
  });

  it("transplants mark when surrounding text changes", () => {
    // Comment on "Hello", typo fix in "wrld" → "world"
    const oldTitle: unknown[][] = [["Hello", [["m", "disc-1"]]], [" wrld"]];
    const newTitle: unknown[][] = [["Hello world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    expect(result).toEqual([["Hello", [["m", "disc-1"]]], [" world"]]);
  });

  it("drops mark when commented text is deleted", () => {
    const oldTitle: unknown[][] = [["Hello", [["m", "disc-1"]]], [" world"]];
    const newTitle: unknown[][] = [["Goodbye world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    // "Hello" not found → mark dropped
    expect(result).toEqual([["Goodbye world"]]);
  });

  it("preserves existing formatting on new title", () => {
    const oldTitle: unknown[][] = [["Hello", [["m", "disc-1"]]], [" world"]];
    const newTitle: unknown[][] = [["Hello", [["b"]]], [" world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    // "Hello" should have both bold and comment mark
    expect(result).toEqual([["Hello", [["b"], ["m", "disc-1"]]], [" world"]]);
  });

  it("handles multiple comment marks", () => {
    const oldTitle: unknown[][] = [
      ["Hello", [["m", "d1"]]],
      [" "],
      ["world", [["m", "d2"]]],
    ];
    const newTitle: unknown[][] = [["Hello world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    // Both marks should be transplanted
    const flat = result.map((d) => String(d[0])).join("");
    expect(flat).toBe("Hello world");
    // Check that both discussion IDs are present
    const allFormats = result.flatMap((d) =>
      Array.isArray(d[1]) ? (d[1] as unknown[][]) : [],
    );
    const mIds = allFormats
      .filter((f) => f[0] === "m")
      .map((f) => f[1]);
    expect(mIds).toContain("d1");
    expect(mIds).toContain("d2");
  });

  it("transplants mark when text is appended", () => {
    const oldTitle: unknown[][] = [["Hello", [["m", "disc-1"]]]];
    const newTitle: unknown[][] = [["Hello world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    expect(result).toEqual([["Hello", [["m", "disc-1"]]], [" world"]]);
  });

  it("transplants mark when text is prepended", () => {
    const oldTitle: unknown[][] = [["world", [["m", "disc-1"]]]];
    const newTitle: unknown[][] = [["Hello world"]];
    const result = transplantCommentMarks(oldTitle, newTitle);
    // "world" found at position 6
    const flat = result.map((d) => String(d[0])).join("");
    expect(flat).toBe("Hello world");
    const worldEntry = result.find((d) => String(d[0]) === "world");
    expect(worldEntry).toBeDefined();
    const formats = worldEntry![1] as unknown[][];
    expect(formats).toContainEqual(["m", "disc-1"]);
  });
});

// ---------------------------------------------------------------------------
// mergeCommentMarks
// ---------------------------------------------------------------------------

describe("mergeCommentMarks", () => {
  it("passes through when old has no properties", () => {
    const newProps = { title: [["hello"]] };
    expect(mergeCommentMarks(undefined, newProps)).toEqual(newProps);
  });

  it("passes through non-decoration properties", () => {
    const oldProps = { checked: [["Yes"]] };
    const newProps = { checked: [["No"]] };
    expect(mergeCommentMarks(oldProps, newProps)).toEqual(newProps);
  });

  it("transplants marks on title property", () => {
    const oldProps = { title: [["Hello", [["m", "d1"]]], [" world"]] };
    const newProps = { title: [["Hello world"]] };
    const result = mergeCommentMarks(oldProps, newProps);
    expect(result.title).toEqual([
      ["Hello", [["m", "d1"]]],
      [" world"],
    ]);
  });
});
