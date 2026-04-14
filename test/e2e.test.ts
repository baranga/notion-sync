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
