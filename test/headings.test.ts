import { describe, it, expect } from "vitest";
import { markdownToBlocks } from "../src/lib/md-to-blocks.js";
import { recordMapToMarkdown } from "../src/lib/recordmap-to-md.js";
import type { ExtendedRecordMap } from "notion-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal record map: a page whose only child is `block`. */
function pageWith(block: Record<string, unknown>): ExtendedRecordMap {
  return {
    block: {
      page: {
        value: {
          id: "page",
          type: "page",
          properties: { title: [["Title"]] },
          content: [block.id as string],
          alive: true,
        },
      },
      [block.id as string]: { value: block },
    },
  } as unknown as ExtendedRecordMap;
}

function headingBlock(type: string, text: string) {
  return { id: "h", type, properties: { title: [[text]] }, alive: true };
}

// ---------------------------------------------------------------------------
// Markdown → Notion blocks
// ---------------------------------------------------------------------------

describe("markdownToBlocks heading depth", () => {
  it("maps H1/H2/H3 to header/sub_header/sub_sub_header", () => {
    expect(markdownToBlocks("# h1")[0].type).toBe("header");
    expect(markdownToBlocks("## h2")[0].type).toBe("sub_header");
    expect(markdownToBlocks("### h3")[0].type).toBe("sub_sub_header");
  });

  it("maps H4 to header_4 (not sub_sub_header)", () => {
    const blocks = markdownToBlocks("#### level 4 headline");
    expect(blocks[0].type).toBe("header_4");
    expect(blocks[0].properties?.title).toEqual([["level 4 headline"]]);
  });

  it("clamps H5/H6 to header_4 (deepest Notion heading)", () => {
    expect(markdownToBlocks("##### h5")[0].type).toBe("header_4");
    expect(markdownToBlocks("###### h6")[0].type).toBe("header_4");
  });
});

// ---------------------------------------------------------------------------
// Notion blocks → Markdown
// ---------------------------------------------------------------------------

describe("recordMapToMarkdown heading depth", () => {
  it("renders header_4 as an H4", () => {
    const md = recordMapToMarkdown(pageWith(headingBlock("header_4", "L4")), "page");
    expect(md).toContain("#### L4");
    expect(md).not.toContain("##### L4");
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("heading round trip", () => {
  it("preserves an H4 through markdown → blocks → markdown", () => {
    const blocks = markdownToBlocks("#### level 4 headline");
    const block = { ...blocks[0], id: "h", alive: true } as Record<string, unknown>;
    const md = recordMapToMarkdown(pageWith(block), "page");
    expect(md).toContain("#### level 4 headline");
  });
});
