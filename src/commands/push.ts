import fs from "node:fs";
import type { NotionAPI } from "notion-client";
import type { Block, ExtendedRecordMap } from "notion-types";
import { getBlockValue } from "notion-utils";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { extractPageId } from "../lib/id.js";
import { fetchPage, submitTransaction } from "../lib/notion.js";
import { markdownToBlocks } from "../lib/md-to-blocks.js";
import { buildReplaceOperations, buildDiffOperations } from "../lib/blocks.js";
import { extractBlocks } from "../lib/recordmap-to-blocks.js";
import { recordMapToMarkdown } from "../lib/recordmap-to-md.js";
import { readShadow, writeShadow } from "../lib/shadow.js";
import type { SyncConfig, SyncOptions } from "../types.js";

function getPageInfo(
  recordMap: ExtendedRecordMap,
  pageId: string,
): { childIds: string[]; spaceId: string } {
  const block = getBlockValue(recordMap.block[pageId]) as Block | undefined;

  const childIds = block?.content ?? [];
  // space_id lives on the block; fall back to the recordMap's space map
  // (present at runtime but not in ExtendedRecordMap's type definition)
  const spaceMap = (recordMap as unknown as Record<string, unknown>).space as
    | Record<string, unknown>
    | undefined;
  const spaceId = block?.space_id ?? Object.keys(spaceMap ?? {})[0] ?? "";

  if (!spaceId) {
    throw new Error("Could not determine space ID from page record");
  }

  return { childIds, spaceId };
}

function countBlocks(blocks: { children?: unknown[] }[]): number {
  let count = 0;
  for (const b of blocks) {
    count++;
    if (b.children) {
      count += countBlocks(b.children as { children?: unknown[] }[]);
    }
  }
  return count;
}

export async function push(
  filePath: string,
  readClient: NotionAPI,
  config: SyncConfig,
  options: SyncOptions,
): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = parseFrontmatter(raw);

  const input = data.notion_url ?? data.notion_id;
  if (!input) {
    throw new Error(
      `${filePath}: frontmatter missing notion_url or notion_id`,
    );
  }

  const pageId = extractPageId(input);
  if (options.verbose) console.log(`  Page ID: ${pageId}`);

  const blocks = markdownToBlocks(content);
  const totalBlocks = countBlocks(blocks);

  if (options.dryRun) {
    console.log(`[dry-run] Would push ${filePath} (${totalBlocks} blocks)`);
    return;
  }

  // Fetch current page to get existing children and space ID
  const recordMap = await fetchPage(readClient, pageId);
  const { childIds, spaceId } = getPageInfo(recordMap, pageId);

  // Check for remote changes since last sync
  if (!options.force) {
    const shadow = readShadow(filePath);
    if (shadow) {
      const baseBody = parseFrontmatter(shadow).content;
      const remoteBody = recordMapToMarkdown(recordMap, pageId);
      if (remoteBody !== baseBody) {
        throw new Error(
          `${filePath}: remote has changed since last sync. Pull first, or use --force to overwrite.`,
        );
      }
      if (options.verbose) console.log("  Remote unchanged since last sync");
    }
  }

  // Diff-based push when there are existing blocks; full replace otherwise
  const existingBlocks = extractBlocks(recordMap, pageId);

  if (options.verbose) {
    console.log(`  Space: ${spaceId}`);
    console.log(`  Existing blocks: ${existingBlocks.length}`);
    console.log(`  New blocks: ${totalBlocks}`);
  }

  const ops =
    existingBlocks.length > 0
      ? buildDiffOperations(pageId, spaceId, existingBlocks, blocks)
      : buildReplaceOperations(pageId, spaceId, childIds, blocks);

  // Update the page title from frontmatter
  if (data.title) {
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: ["properties", "title"],
      command: "set",
      args: [[data.title]],
    });
  }

  await submitTransaction(config.tokenV2, spaceId, ops);

  writeShadow(filePath, raw);
  console.log(`Pushed: ${filePath} (${totalBlocks} blocks)`);
}
