import { describe, it, expect } from "vitest";
import { buildDiffOperations } from "../src/lib/blocks.js";
import type { BlockRecord } from "../src/lib/blocks.js";
import { markdownToBlocks } from "../src/lib/md-to-blocks.js";

const PAGE = "page-parent";
const SPACE = "space-1";

function text(text: string, id: string): BlockRecord {
  return { id, type: "text", properties: { title: [[text]] } };
}

function subPage(id: string, title = "Child"): BlockRecord {
  return { id, type: "page", properties: { title: [[title]] } };
}

/** Ops that would kill a block: soft-delete or removal from a content list. */
function isDeletedBy(ops: ReturnType<typeof buildDiffOperations>, id: string): boolean {
  return ops.some(
    (op) =>
      (op.pointer.id === id &&
        op.command === "update" &&
        (op.args as { alive?: boolean }).alive === false) ||
      (op.command === "listRemove" && (op.args as { id?: string }).id === id),
  );
}

/** The final content order set on a parent, if any. */
function contentOrder(
  ops: ReturnType<typeof buildDiffOperations>,
  parentId: string,
): string[] | undefined {
  const setOp = [...ops]
    .reverse()
    .find(
      (op) =>
        op.pointer.id === parentId &&
        op.command === "set" &&
        op.path.join(".") === "content",
    );
  return setOp?.args as string[] | undefined;
}

describe("sub-page preservation in buildDiffOperations", () => {
  it("does not delete a sub-page that is absent from the new blocks", () => {
    const oldBlocks = [text("intro", "b1"), subPage("sub-1"), text("outro", "b2")];
    // Markdown round-trip drops the sub-page; new blocks only have the text.
    const newBlocks = [text("intro", "n1"), text("outro", "n2")];

    const ops = buildDiffOperations(PAGE, SPACE, oldBlocks, newBlocks);

    expect(isDeletedBy(ops, "sub-1")).toBe(false);
  });

  it("keeps the sub-page in the parent content order at its original position", () => {
    const oldBlocks = [text("intro", "b1"), subPage("sub-1"), text("outro", "b2")];
    const newBlocks = [text("changed", "n1")]; // user deleted the outro paragraph

    const ops = buildDiffOperations(PAGE, SPACE, oldBlocks, newBlocks);

    const order = contentOrder(ops, PAGE);
    expect(order).toBeDefined();
    expect(order).toContain("sub-1");
    expect(isDeletedBy(ops, "sub-1")).toBe(false);
  });

  it("preserves a nested sub-page inside a toggle", () => {
    const oldBlocks: BlockRecord[] = [
      {
        id: "tog",
        type: "toggle",
        properties: { title: [["Details"]] },
        children: [text("body", "c1"), subPage("nested-sub")],
      },
    ];
    const newBlocks: BlockRecord[] = [
      {
        id: "tog-new",
        type: "toggle",
        properties: { title: [["Details"]] },
        children: [text("body", "cn1")],
      },
    ];

    const ops = buildDiffOperations(PAGE, SPACE, oldBlocks, newBlocks);

    expect(isDeletedBy(ops, "nested-sub")).toBe(false);
  });

  it("still deletes ordinary blocks removed from the Markdown", () => {
    const oldBlocks = [text("keep", "b1"), text("remove", "b2")];
    const newBlocks = [text("keep", "n1")];

    const ops = buildDiffOperations(PAGE, SPACE, oldBlocks, newBlocks);

    expect(isDeletedBy(ops, "b2")).toBe(true);
  });
});

describe("markdownToBlocks drops sub-page links", () => {
  it("does not emit a block for a standalone Notion page link", () => {
    const md = "Some text\n\n[Child Page](https://www.notion.so/1234567890abcdef1234567890abcdef)\n\nMore text\n";
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
  });

  it("recognizes page links that include a title slug and dashes", () => {
    const md = "[My Child](https://www.notion.so/My-Child-1234567890abcdef1234567890abcdef)\n";
    expect(markdownToBlocks(md)).toEqual([]);
  });

  it("keeps ordinary external links as text blocks", () => {
    const md = "[Example](https://example.com/page)\n";
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});
