/**
 * E2E test: verifies that Notion comments (["m", discussionId] marks)
 * survive a pull → edit → push cycle.
 *
 * Requires env vars:
 *   NOTION_TOKEN_V2     — a valid token_v2 cookie value
 *   NOTION_TEST_PAGE    — UUID of a page to create test sub-pages under
 *
 * The test creates a temporary sub-page, runs the sync cycle, asserts
 * on the result, then deletes the sub-page.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotionAPI } from "notion-client";
import type { Block } from "notion-types";
import { getBlockValue } from "notion-utils";
import { fetchPage, submitTransaction } from "../src/lib/notion.js";
import { pull } from "../src/commands/pull.js";
import { push } from "../src/commands/push.js";

const TOKEN = process.env.NOTION_TOKEN_V2;
const PARENT_PAGE = process.env.NOTION_TEST_PAGE;
const KEEP_PAGE = process.env.KEEP_TEST_PAGE === "1";
const INLINE_DISC_ID = crypto.randomUUID();
const BLOCK_DISC_ID = crypto.randomUUID();

describe.skipIf(!TOKEN || !PARENT_PAGE)("e2e: comment preservation", () => {
  let client: NotionAPI;
  let spaceId: string;
  let userId: string;
  let testPageId: string;
  let commentedBlockId: string;
  let otherBlockId: string;
  let blockCommentedId: string; // block with a block-level (non-inline) comment
  let tmpDir: string;
  let filePath: string;
  let origCwd: string;

  beforeAll(async () => {
    client = new NotionAPI({ authToken: TOKEN! });

    // Resolve spaceId from the parent page
    const parentMap = await fetchPage(client, PARENT_PAGE!);
    const parentBlock = getBlockValue(parentMap.block[PARENT_PAGE!]) as
      | Block
      | undefined;
    const spaceMap = (parentMap as unknown as Record<string, unknown>)
      .space as Record<string, unknown> | undefined;
    spaceId =
      parentBlock?.space_id ?? Object.keys(spaceMap ?? {})[0] ?? "";
    if (!spaceId) throw new Error("Could not resolve spaceId");

    userId =
      parentBlock?.created_by_id ??
      Object.keys(parentMap.notion_user ?? {})[0] ??
      "";

    // Create a test page with three text blocks + comments
    testPageId = crypto.randomUUID();
    commentedBlockId = crypto.randomUUID();
    otherBlockId = crypto.randomUUID();
    blockCommentedId = crypto.randomUUID();
    const inlineCommentId = crypto.randomUUID();
    const blockCommentId = crypto.randomUUID();
    const now = Date.now();

    // Transaction 1: create page + blocks (with comment mark already in title)
    await submitTransaction(TOKEN!, spaceId, [
      {
        pointer: { table: "block", id: testPageId, spaceId },
        path: [],
        command: "set",
        args: {
          id: testPageId,
          version: 1,
          type: "page",
          properties: { title: [["E2E Comment Test"]] },
          content: [commentedBlockId, otherBlockId, blockCommentedId],
          parent_id: PARENT_PAGE!,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      {
        pointer: { table: "block", id: PARENT_PAGE!, spaceId },
        path: ["content"],
        command: "listAfter",
        args: { id: testPageId },
      },
      {
        pointer: { table: "block", id: commentedBlockId, spaceId },
        path: [],
        command: "set",
        args: {
          id: commentedBlockId,
          version: 1,
          type: "text",
          properties: {
            title: [["Hello", [["m", INLINE_DISC_ID]]], [" world"]],
          },
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      {
        pointer: { table: "block", id: otherBlockId, spaceId },
        path: [],
        command: "set",
        args: {
          id: otherBlockId,
          version: 1,
          type: "text",
          properties: { title: [["Some other text"]] },
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // -- block 3: has a block-level comment (no inline mark) --
      {
        pointer: { table: "block", id: blockCommentedId, spaceId },
        path: [],
        command: "set",
        args: {
          id: blockCommentedId,
          version: 1,
          type: "text",
          properties: { title: [["Block with full comment"]] },
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
    ]);

    // Transaction 2: inline comment on block 1
    await submitTransaction(TOKEN!, spaceId, [
      {
        pointer: { table: "block", id: commentedBlockId, spaceId },
        path: ["discussions"],
        command: "listAfter",
        args: { id: INLINE_DISC_ID },
      },
      {
        pointer: { table: "discussion", id: INLINE_DISC_ID, spaceId },
        path: [],
        command: "set",
        args: {
          id: INLINE_DISC_ID,
          parent_id: commentedBlockId,
          parent_table: "block",
          resolved: false,
          context: [["Hello", [["m", INLINE_DISC_ID]]]],
          comments: [inlineCommentId],
          space_id: spaceId,
          version: 1,
        },
      },
      {
        pointer: { table: "comment", id: inlineCommentId, spaceId },
        path: [],
        command: "set",
        args: {
          id: inlineCommentId,
          version: 1,
          parent_id: INLINE_DISC_ID,
          parent_table: "discussion",
          text: [["Inline comment on Hello"]],
          alive: true,
          space_id: spaceId,
          created_by_id: userId,
          created_by_table: "notion_user",
          created_time: now,
          last_edited_time: now,
        },
      },
    ]);

    // Transaction 3: block-level comment on block 3 (no inline mark, just
    // a discussion attached to the block ID)
    await submitTransaction(TOKEN!, spaceId, [
      {
        pointer: { table: "block", id: blockCommentedId, spaceId },
        path: ["discussions"],
        command: "listAfter",
        args: { id: BLOCK_DISC_ID },
      },
      {
        pointer: { table: "discussion", id: BLOCK_DISC_ID, spaceId },
        path: [],
        command: "set",
        args: {
          id: BLOCK_DISC_ID,
          parent_id: blockCommentedId,
          parent_table: "block",
          resolved: false,
          comments: [blockCommentId],
          space_id: spaceId,
          version: 1,
        },
      },
      {
        pointer: { table: "comment", id: blockCommentId, spaceId },
        path: [],
        command: "set",
        args: {
          id: blockCommentId,
          version: 1,
          parent_id: BLOCK_DISC_ID,
          parent_table: "discussion",
          text: [["Block-level comment"]],
          alive: true,
          space_id: spaceId,
          created_by_id: userId,
          created_by_table: "notion_user",
          created_time: now,
          last_edited_time: now,
        },
      },
    ]);

    // Temp directory — chdir into it so shadow files land here
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-e2e-"));
    filePath = path.join(tmpDir, "test.md");
    origCwd = process.cwd();
    process.chdir(tmpDir);
  }, 30_000);

  afterAll(async () => {
    // Restore working directory first
    if (origCwd) process.chdir(origCwd);

    if (KEEP_PAGE) {
      const url = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
      console.log(`\nKept test page: ${url}\n`);
    } else if (testPageId && spaceId) {
      try {
        await submitTransaction(TOKEN!, spaceId, [
          {
            pointer: { table: "block", id: testPageId, spaceId },
            path: [],
            command: "update",
            args: { alive: false },
          },
          {
            pointer: { table: "block", id: PARENT_PAGE!, spaceId },
            path: ["content"],
            command: "listRemove",
            args: { id: testPageId },
          },
        ]);
      } catch {
        // Best-effort cleanup
      }
    }

    // Remove temp dir
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const syncConfig = () => ({
    tokenV2: TOKEN!,
    source: "env" as const,
  });

  const syncOptions = (force = true) => ({
    dryRun: false,
    verbose: false,
    force,
  });

  async function fetchBlock(blockId: string): Promise<Block> {
    const map = await fetchPage(client, testPageId);
    const block = getBlockValue(map.block[blockId]) as Block | undefined;
    if (!block) throw new Error(`Block ${blockId} not found`);
    return block;
  }

  function getDiscussionMarks(block: Block): string[] {
    const title = block.properties?.title;
    if (!Array.isArray(title)) return [];
    return (title as unknown[][]).flatMap((dec: unknown[]) => {
      if (!Array.isArray(dec[1])) return [];
      return (dec[1] as unknown[][])
        .filter((fmt: unknown[]) => fmt[0] === "m")
        .map((fmt: unknown[]) => fmt[1] as string);
    });
  }

  /** Fetch discussion IDs attached to a block. */
  async function fetchDiscussionIds(blockId: string): Promise<string[]> {
    const block = await fetchBlock(blockId);
    // The `discussions` array isn't in the Block type but exists at runtime
    return (block as unknown as Record<string, unknown>).discussions as
      | string[]
      | undefined ?? [];
  }

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------

  it("preserves comment mark when only a different block is edited", async () => {
    // Seed the local file so pull can find the frontmatter
    const pageUrl = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
    fs.writeFileSync(
      filePath,
      `---\nnotion_url: ${pageUrl}\ntitle: E2E Comment Test\n---\n\n`,
    );

    // Pull
    await pull(filePath, client, syncConfig(), syncOptions());
    let md = fs.readFileSync(filePath, "utf-8");
    expect(md).toContain("Hello world");
    expect(md).toContain("Some other text");

    // Edit only block 2
    md = md.replace("Some other text", "Some MODIFIED text");
    fs.writeFileSync(filePath, md);

    // Push
    await push(filePath, client, syncConfig(), syncOptions());

    // Verify block 1 is untouched: same ID, alive, comment mark present
    const block = await fetchBlock(commentedBlockId);
    expect(block.alive).toBe(true);
    expect(block.id).toBe(commentedBlockId);
    expect(getDiscussionMarks(block)).toContain(INLINE_DISC_ID);

    // Verify block 2 was updated
    const block2 = await fetchBlock(otherBlockId);
    const text = (block2.properties?.title as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
    expect(text).toBe("Some MODIFIED text");
  }, 30_000);

  it("preserves comment mark when the commented block itself is edited", async () => {
    // Read current state
    let md = fs.readFileSync(filePath, "utf-8");

    // Change "world" → "everyone" (but keep "Hello" which carries the mark)
    md = md.replace("Hello world", "Hello everyone");
    fs.writeFileSync(filePath, md);

    // Push
    await push(filePath, client, syncConfig(), syncOptions());

    // Verify block ID preserved and text updated
    const block = await fetchBlock(commentedBlockId);
    expect(block.id).toBe(commentedBlockId);
    const plainText = (block.properties?.title as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
    expect(plainText).toBe("Hello everyone");

    // The ["m"] mark on "Hello" should still be there
    expect(getDiscussionMarks(block)).toContain(INLINE_DISC_ID);
  }, 30_000);

  it("preserves block-level comment when the block text is edited", async () => {
    // Verify the discussion exists on block 3 before push
    const discsBefore = await fetchDiscussionIds(blockCommentedId);
    expect(discsBefore).toContain(BLOCK_DISC_ID);

    // Edit block 3's text
    let md = fs.readFileSync(filePath, "utf-8");
    md = md.replace("Block with full comment", "Block with full comment (edited)");
    fs.writeFileSync(filePath, md);

    // Push
    await push(filePath, client, syncConfig(), syncOptions());

    // Block ID must be preserved
    const block = await fetchBlock(blockCommentedId);
    expect(block.id).toBe(blockCommentedId);
    expect(block.alive).toBe(true);

    const plainText = (block.properties?.title as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
    expect(plainText).toBe("Block with full comment (edited)");

    // The discussion must still be attached to the same block ID
    const discsAfter = await fetchDiscussionIds(blockCommentedId);
    expect(discsAfter).toContain(BLOCK_DISC_ID);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Toggle (<details>/<summary>) round-trip
// ---------------------------------------------------------------------------

describe.skipIf(!TOKEN || !PARENT_PAGE)("e2e: toggle sync", () => {
  let client: NotionAPI;
  let spaceId: string;
  let testPageId: string;
  let toggleBlockId: string;
  let toggleChildId: string;
  let textBeforeId: string;
  let tmpDir: string;
  let filePath: string;
  let origCwd: string;

  beforeAll(async () => {
    client = new NotionAPI({ authToken: TOKEN! });

    // Resolve spaceId from the parent page
    const parentMap = await fetchPage(client, PARENT_PAGE!);
    const parentBlock = getBlockValue(parentMap.block[PARENT_PAGE!]) as
      | Block
      | undefined;
    const spaceMap = (parentMap as unknown as Record<string, unknown>)
      .space as Record<string, unknown> | undefined;
    spaceId =
      parentBlock?.space_id ?? Object.keys(spaceMap ?? {})[0] ?? "";
    if (!spaceId) throw new Error("Could not resolve spaceId");

    // Create a test page with: text block, toggle block (with bold title + child text)
    testPageId = crypto.randomUUID();
    textBeforeId = crypto.randomUUID();
    toggleBlockId = crypto.randomUUID();
    toggleChildId = crypto.randomUUID();
    const now = Date.now();

    await submitTransaction(TOKEN!, spaceId, [
      // Page
      {
        pointer: { table: "block", id: testPageId, spaceId },
        path: [],
        command: "set",
        args: {
          id: testPageId,
          version: 1,
          type: "page",
          properties: { title: [["E2E Toggle Test"]] },
          content: [textBeforeId, toggleBlockId],
          parent_id: PARENT_PAGE!,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      {
        pointer: { table: "block", id: PARENT_PAGE!, spaceId },
        path: ["content"],
        command: "listAfter",
        args: { id: testPageId },
      },
      // Text block before toggle
      {
        pointer: { table: "block", id: textBeforeId, spaceId },
        path: [],
        command: "set",
        args: {
          id: textBeforeId,
          version: 1,
          type: "text",
          properties: { title: [["Paragraph before toggle"]] },
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Toggle block with bold title
      {
        pointer: { table: "block", id: toggleBlockId, spaceId },
        path: [],
        command: "set",
        args: {
          id: toggleBlockId,
          version: 1,
          type: "toggle",
          properties: {
            title: [["Source References", [["b"]]]],
          },
          content: [toggleChildId],
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Child text block inside toggle
      {
        pointer: { table: "block", id: toggleChildId, spaceId },
        path: [],
        command: "set",
        args: {
          id: toggleChildId,
          version: 1,
          type: "text",
          properties: { title: [["Reference details here"]] },
          parent_id: toggleBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
    ]);

    // Temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-e2e-toggle-"));
    filePath = path.join(tmpDir, "toggle-test.md");
    origCwd = process.cwd();
    process.chdir(tmpDir);
  }, 30_000);

  afterAll(async () => {
    if (origCwd) process.chdir(origCwd);

    if (KEEP_PAGE) {
      const url = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
      console.log(`\nKept test page: ${url}\n`);
    } else if (testPageId && spaceId) {
      try {
        await submitTransaction(TOKEN!, spaceId, [
          {
            pointer: { table: "block", id: testPageId, spaceId },
            path: [],
            command: "update",
            args: { alive: false },
          },
          {
            pointer: { table: "block", id: PARENT_PAGE!, spaceId },
            path: ["content"],
            command: "listRemove",
            args: { id: testPageId },
          },
        ]);
      } catch {
        // Best-effort cleanup
      }
    }

    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  const syncConfig = () => ({
    tokenV2: TOKEN!,
    source: "env" as const,
  });

  const syncOptions = (force = true) => ({
    dryRun: false,
    verbose: false,
    force,
  });

  async function fetchBlock(blockId: string): Promise<Block> {
    const map = await fetchPage(client, testPageId);
    const block = getBlockValue(map.block[blockId]) as Block | undefined;
    if (!block) throw new Error(`Block ${blockId} not found`);
    return block;
  }

  it("pull renders toggle as <details>/<summary> with formatting and children", async () => {
    const pageUrl = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
    fs.writeFileSync(
      filePath,
      `---\nnotion_url: ${pageUrl}\ntitle: E2E Toggle Test\n---\n\n`,
    );

    await pull(filePath, client, syncConfig(), syncOptions());
    const md = fs.readFileSync(filePath, "utf-8");

    // Toggle summary with bold formatting
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>**Source References**</summary>");
    expect(md).toContain("</details>");

    // Toggle child content present between summary and closing tag
    expect(md).toContain("Reference details here");

    // Text before toggle still present
    expect(md).toContain("Paragraph before toggle");
  }, 30_000);

  it("push round-trips toggle structure back to Notion", async () => {
    // Read the pulled file and push it back unchanged
    await push(filePath, client, syncConfig(), syncOptions());

    // Toggle block preserved with correct type and bold title
    const toggle = await fetchBlock(toggleBlockId);
    expect(toggle.type).toBe("toggle");
    expect(toggle.alive).toBe(true);
    const titleDecs = toggle.properties?.title as unknown[][];
    const plainTitle = titleDecs.map((d: unknown[]) => String(d[0])).join("");
    expect(plainTitle).toBe("Source References");
    // Bold decoration present
    const hasBold = titleDecs.some(
      (d: unknown[]) =>
        Array.isArray(d[1]) &&
        (d[1] as unknown[][]).some((fmt) => fmt[0] === "b"),
    );
    expect(hasBold).toBe(true);

    // Toggle child preserved
    expect(toggle.content).toBeDefined();
    expect(toggle.content!.length).toBeGreaterThanOrEqual(1);
    const childBlock = await fetchBlock(toggle.content![0]);
    expect(childBlock.type).toBe("text");
    const childText = (childBlock.properties?.title as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
    expect(childText).toBe("Reference details here");
  }, 30_000);

  it("editing toggle child content and pushing preserves structure", async () => {
    let md = fs.readFileSync(filePath, "utf-8");

    // Edit the toggle child content
    md = md.replace("Reference details here", "Updated references");
    fs.writeFileSync(filePath, md);

    await push(filePath, client, syncConfig(), syncOptions());

    // Toggle block ID preserved
    const toggle = await fetchBlock(toggleBlockId);
    expect(toggle.id).toBe(toggleBlockId);
    expect(toggle.type).toBe("toggle");

    // Child content updated
    const childBlock = await fetchBlock(toggle.content![0]);
    const childText = (childBlock.properties?.title as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
    expect(childText).toBe("Updated references");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Complex toggle: formatted title, rich text child, and table child
// ---------------------------------------------------------------------------

describe.skipIf(!TOKEN || !PARENT_PAGE)("e2e: complex toggle sync", () => {
  let client: NotionAPI;
  let spaceId: string;
  let testPageId: string;
  let toggleBlockId: string;
  let richTextChildId: string;
  let tableBlockId: string;
  let tableRow1Id: string;
  let tableRow2Id: string;
  let tableRow3Id: string;
  let tmpDir: string;
  let filePath: string;
  let origCwd: string;

  beforeAll(async () => {
    client = new NotionAPI({ authToken: TOKEN! });

    const parentMap = await fetchPage(client, PARENT_PAGE!);
    const parentBlock = getBlockValue(parentMap.block[PARENT_PAGE!]) as
      | Block
      | undefined;
    const spaceMap = (parentMap as unknown as Record<string, unknown>)
      .space as Record<string, unknown> | undefined;
    spaceId =
      parentBlock?.space_id ?? Object.keys(spaceMap ?? {})[0] ?? "";
    if (!spaceId) throw new Error("Could not resolve spaceId");

    testPageId = crypto.randomUUID();
    toggleBlockId = crypto.randomUUID();
    richTextChildId = crypto.randomUUID();
    tableBlockId = crypto.randomUUID();
    tableRow1Id = crypto.randomUUID();
    tableRow2Id = crypto.randomUUID();
    tableRow3Id = crypto.randomUUID();
    const now = Date.now();

    // Page with a single toggle containing: rich text block + table
    await submitTransaction(TOKEN!, spaceId, [
      {
        pointer: { table: "block", id: testPageId, spaceId },
        path: [],
        command: "set",
        args: {
          id: testPageId,
          version: 1,
          type: "page",
          properties: { title: [["E2E Complex Toggle Test"]] },
          content: [toggleBlockId],
          parent_id: PARENT_PAGE!,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      {
        pointer: { table: "block", id: PARENT_PAGE!, spaceId },
        path: ["content"],
        command: "listAfter",
        args: { id: testPageId },
      },
      // Toggle with mixed formatting: "Source " + bold "References" + " & " + italic "Notes"
      {
        pointer: { table: "block", id: toggleBlockId, spaceId },
        path: [],
        command: "set",
        args: {
          id: toggleBlockId,
          version: 1,
          type: "toggle",
          properties: {
            title: [
              ["Source "],
              ["References", [["b"]]],
              [" & "],
              ["Notes", [["i"]]],
            ],
          },
          content: [richTextChildId, tableBlockId],
          parent_id: testPageId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Rich text child: "See " + bold link "the docs" + " for details"
      {
        pointer: { table: "block", id: richTextChildId, spaceId },
        path: [],
        command: "set",
        args: {
          id: richTextChildId,
          version: 1,
          type: "text",
          properties: {
            title: [
              ["See "],
              ["the docs", [["b"], ["a", "https://example.com"]]],
              [" for details"],
            ],
          },
          parent_id: toggleBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Table block (header + 2 data rows)
      {
        pointer: { table: "block", id: tableBlockId, spaceId },
        path: [],
        command: "set",
        args: {
          id: tableBlockId,
          version: 1,
          type: "table",
          format: {
            table_block_column_order: ["a", "b"],
            table_block_column_format: {},
            table_block_column_header: true,
          },
          content: [tableRow1Id, tableRow2Id, tableRow3Id],
          parent_id: toggleBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Header row
      {
        pointer: { table: "block", id: tableRow1Id, spaceId },
        path: [],
        command: "set",
        args: {
          id: tableRow1Id,
          version: 1,
          type: "table_row",
          properties: { a: [["Name"]], b: [["URL"]] },
          parent_id: tableBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Data row 1
      {
        pointer: { table: "block", id: tableRow2Id, spaceId },
        path: [],
        command: "set",
        args: {
          id: tableRow2Id,
          version: 1,
          type: "table_row",
          properties: { a: [["Example"]], b: [["https://example.com"]] },
          parent_id: tableBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      // Data row 2
      {
        pointer: { table: "block", id: tableRow3Id, spaceId },
        path: [],
        command: "set",
        args: {
          id: tableRow3Id,
          version: 1,
          type: "table_row",
          properties: {
            a: [["Docs"]],
            b: [["https://docs.example.com"]],
          },
          parent_id: tableBlockId,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
    ]);

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "notion-sync-e2e-complex-toggle-"),
    );
    filePath = path.join(tmpDir, "complex-toggle.md");
    origCwd = process.cwd();
    process.chdir(tmpDir);
  }, 30_000);

  afterAll(async () => {
    if (origCwd) process.chdir(origCwd);

    if (KEEP_PAGE) {
      const url = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
      console.log(`\nKept test page: ${url}\n`);
    } else if (testPageId && spaceId) {
      try {
        await submitTransaction(TOKEN!, spaceId, [
          {
            pointer: { table: "block", id: testPageId, spaceId },
            path: [],
            command: "update",
            args: { alive: false },
          },
          {
            pointer: { table: "block", id: PARENT_PAGE!, spaceId },
            path: ["content"],
            command: "listRemove",
            args: { id: testPageId },
          },
        ]);
      } catch {
        // Best-effort cleanup
      }
    }

    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  const syncConfig = () => ({
    tokenV2: TOKEN!,
    source: "env" as const,
  });

  const syncOptions = (force = true) => ({
    dryRun: false,
    verbose: false,
    force,
  });

  async function fetchBlock(blockId: string): Promise<Block> {
    const map = await fetchPage(client, testPageId);
    const block = getBlockValue(map.block[blockId]) as Block | undefined;
    if (!block) throw new Error(`Block ${blockId} not found`);
    return block;
  }

  function blockPlainText(block: Block): string {
    return ((block.properties?.title ?? []) as unknown[][])
      .map((d: unknown[]) => String(d[0]))
      .join("");
  }

  it("pull renders formatted summary, rich text, and table inside toggle", async () => {
    const pageUrl = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
    fs.writeFileSync(
      filePath,
      `---\nnotion_url: ${pageUrl}\ntitle: E2E Complex Toggle Test\n---\n\n`,
    );

    await pull(filePath, client, syncConfig(), syncOptions());
    const md = fs.readFileSync(filePath, "utf-8");

    // Summary with mixed bold + italic formatting
    expect(md).toContain("<summary>");
    expect(md).toContain("**References**");
    expect(md).toContain("*Notes*");
    expect(md).toContain("</summary>");

    // Rich text child with bold link
    expect(md).toContain("[**the docs**](https://example.com)");
    expect(md).toContain("for details");

    // Table inside toggle
    expect(md).toContain("| Name | URL |");
    expect(md).toContain("| Example | https://example.com |");
    expect(md).toContain("| Docs | https://docs.example.com |");

    expect(md).toContain("</details>");
  }, 30_000);

  it("push round-trips complex toggle structure back to Notion", async () => {
    await push(filePath, client, syncConfig(), syncOptions());

    // Toggle preserved with mixed-format title
    const toggle = await fetchBlock(toggleBlockId);
    expect(toggle.type).toBe("toggle");
    expect(toggle.alive).toBe(true);

    const titleDecs = toggle.properties?.title as unknown[][];
    const plainTitle = titleDecs.map((d: unknown[]) => String(d[0])).join("");
    expect(plainTitle).toBe("Source References & Notes");

    // Bold on "References"
    const boldDec = titleDecs.find((d) => String(d[0]) === "References");
    expect(boldDec).toBeDefined();
    expect((boldDec![1] as unknown[][]).some((f) => f[0] === "b")).toBe(true);

    // Italic on "Notes"
    const italicDec = titleDecs.find((d) => String(d[0]) === "Notes");
    expect(italicDec).toBeDefined();
    expect((italicDec![1] as unknown[][]).some((f) => f[0] === "i")).toBe(true);

    // Two children: text + table
    expect(toggle.content!.length).toBe(2);

    // Rich text child: bold link
    const richChild = await fetchBlock(toggle.content![0]);
    expect(richChild.type).toBe("text");
    expect(blockPlainText(richChild)).toBe("See the docs for details");
    const linkDec = (richChild.properties!.title as unknown[][]).find(
      (d) => String(d[0]) === "the docs",
    );
    expect(linkDec).toBeDefined();
    const linkFmts = linkDec![1] as unknown[][];
    expect(linkFmts.some((f) => f[0] === "b")).toBe(true);
    expect(linkFmts.some((f) => f[0] === "a" && f[1] === "https://example.com")).toBe(true);

    // Table child
    const table = await fetchBlock(toggle.content![1]);
    expect(table.type).toBe("table");
    expect(table.content!.length).toBe(3);

    // Verify table rows
    const headerRow = await fetchBlock(table.content![0]);
    expect(headerRow.type).toBe("table_row");
    expect((headerRow.properties!.a as unknown[][])[0][0]).toBe("Name");
    expect((headerRow.properties!.b as unknown[][])[0][0]).toBe("URL");

    const dataRow1 = await fetchBlock(table.content![1]);
    expect((dataRow1.properties!.a as unknown[][])[0][0]).toBe("Example");
    expect((dataRow1.properties!.b as unknown[][])[0][0]).toBe("https://example.com");

    const dataRow2 = await fetchBlock(table.content![2]);
    expect((dataRow2.properties!.a as unknown[][])[0][0]).toBe("Docs");
    expect((dataRow2.properties!.b as unknown[][])[0][0]).toBe("https://docs.example.com");
  }, 30_000);

  it("editing table cell and rich text inside toggle round-trips", async () => {
    let md = fs.readFileSync(filePath, "utf-8");

    // Edit a table cell and the rich text
    md = md.replace("| Docs |", "| Documentation |");
    md = md.replace("for details", "for more info");
    fs.writeFileSync(filePath, md);

    await push(filePath, client, syncConfig(), syncOptions());

    // Toggle block ID preserved
    const toggle = await fetchBlock(toggleBlockId);
    expect(toggle.id).toBe(toggleBlockId);
    expect(toggle.type).toBe("toggle");

    // Rich text updated
    const richChild = await fetchBlock(toggle.content![0]);
    expect(blockPlainText(richChild)).toBe("See the docs for more info");

    // Table row updated
    const table = await fetchBlock(toggle.content![1]);
    const dataRow2 = await fetchBlock(table.content![2]);
    expect((dataRow2.properties!.a as unknown[][])[0][0]).toBe("Documentation");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Heading levels: H1–H4 round-trip (H4 is Notion's `header_4` block)
// ---------------------------------------------------------------------------

describe.skipIf(!TOKEN || !PARENT_PAGE)("e2e: heading level sync", () => {
  let client: NotionAPI;
  let spaceId: string;
  let testPageId: string;
  let tmpDir: string;
  let filePath: string;
  let origCwd: string;

  beforeAll(async () => {
    client = new NotionAPI({ authToken: TOKEN! });

    const parentMap = await fetchPage(client, PARENT_PAGE!);
    const parentBlock = getBlockValue(parentMap.block[PARENT_PAGE!]) as
      | Block
      | undefined;
    const spaceMap = (parentMap as unknown as Record<string, unknown>)
      .space as Record<string, unknown> | undefined;
    spaceId =
      parentBlock?.space_id ?? Object.keys(spaceMap ?? {})[0] ?? "";
    if (!spaceId) throw new Error("Could not resolve spaceId");

    // Create an empty test page; push will populate its headings.
    testPageId = crypto.randomUUID();
    const now = Date.now();
    await submitTransaction(TOKEN!, spaceId, [
      {
        pointer: { table: "block", id: testPageId, spaceId },
        path: [],
        command: "set",
        args: {
          id: testPageId,
          version: 1,
          type: "page",
          properties: { title: [["E2E Heading Test"]] },
          content: [],
          parent_id: PARENT_PAGE!,
          parent_table: "block",
          alive: true,
          created_time: now,
          last_edited_time: now,
        },
      },
      {
        pointer: { table: "block", id: PARENT_PAGE!, spaceId },
        path: ["content"],
        command: "listAfter",
        args: { id: testPageId },
      },
    ]);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-e2e-"));
    filePath = path.join(tmpDir, "headings.md");
    origCwd = process.cwd();
    process.chdir(tmpDir);
  }, 30_000);

  afterAll(async () => {
    if (origCwd) process.chdir(origCwd);

    if (KEEP_PAGE) {
      const url = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
      console.log(`\nKept test page: ${url}\n`);
    } else if (testPageId && spaceId) {
      try {
        await submitTransaction(TOKEN!, spaceId, [
          {
            pointer: { table: "block", id: testPageId, spaceId },
            path: [],
            command: "update",
            args: { alive: false },
          },
          {
            pointer: { table: "block", id: PARENT_PAGE!, spaceId },
            path: ["content"],
            command: "listRemove",
            args: { id: testPageId },
          },
        ]);
      } catch {
        // Best-effort cleanup
      }
    }

    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  const syncConfig = () => ({ tokenV2: TOKEN!, source: "env" as const });
  const syncOptions = (force = true) => ({
    dryRun: false,
    verbose: false,
    force,
  });

  async function fetchBlock(blockId: string): Promise<Block> {
    const map = await fetchPage(client, testPageId);
    const block = getBlockValue(map.block[blockId]) as Block | undefined;
    if (!block) throw new Error(`Block ${blockId} not found`);
    return block;
  }

  it("pushes an H4 markdown heading as a Notion header_4 block", async () => {
    const pageUrl = `https://www.notion.so/${testPageId.replace(/-/g, "")}`;
    fs.writeFileSync(
      filePath,
      `---\nnotion_url: ${pageUrl}\ntitle: E2E Heading Test\n---\n\n` +
        `# h1\n\n## h2\n\n### h3\n\n#### level 4 headline\n`,
    );

    await push(filePath, client, syncConfig(), syncOptions());

    const page = await fetchBlock(testPageId);
    const types: string[] = [];
    for (const childId of page.content ?? []) {
      types.push((await fetchBlock(childId)).type);
    }
    expect(types).toEqual([
      "header",
      "sub_header",
      "sub_sub_header",
      "header_4",
    ]);
  }, 30_000);

  it("pulls the header_4 block back as an H4 markdown heading", async () => {
    await pull(filePath, client, syncConfig(), syncOptions());
    const md = fs.readFileSync(filePath, "utf-8");
    expect(md).toContain("#### level 4 headline");
    // It must not degrade to H3 (the pre-fix behaviour).
    expect(md).not.toMatch(/^### level 4 headline$/m);
  }, 30_000);
});
