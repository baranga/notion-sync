import fs from "node:fs";
import type { NotionAPI } from "notion-client";
import type { Block, ExtendedRecordMap } from "notion-types";
import { getBlockValue } from "notion-utils";
import { prompt } from "../lib/prompt.js";
import { parseFrontmatter, stringifyFrontmatter } from "../lib/frontmatter.js";
import { extractPageId } from "../lib/id.js";
import { fetchPage, submitTransaction } from "../lib/notion.js";
import { markdownToBlocks } from "../lib/md-to-blocks.js";
import { buildReplaceOperations, buildDiffOperations } from "../lib/blocks.js";
import { extractBlocks } from "../lib/recordmap-to-blocks.js";
import { recordMapToMarkdown, recordMapToTitle } from "../lib/recordmap-to-md.js";
import { readShadow, writeShadow } from "../lib/shadow.js";
import type { FileFrontmatter, SyncConfig, SyncOptions } from "../types.js";

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

/**
 * No page reference in frontmatter (e.g. a brand-new local file). Prompt for a
 * Notion URL or ID, validate it, and persist it back into the file's
 * frontmatter so subsequent pushes are non-interactive. Returns the raw input
 * the user gave (URL or ID), which `extractPageId` then normalizes.
 */
async function promptForPageRef(
  filePath: string,
  data: FileFrontmatter,
  content: string,
  options: SyncOptions,
): Promise<string> {
  console.error(`${filePath}: no notion_url or notion_id in frontmatter.`);
  const answer = await prompt("Enter the Notion page URL or ID: ");
  if (!answer) {
    throw new Error(`${filePath}: no Notion page URL or ID provided`);
  }

  // Validate before persisting so we never write an unusable reference.
  extractPageId(answer);

  const key = /^https?:\/\//i.test(answer) ? "notion_url" : "notion_id";
  data[key] = answer;

  if (options.dryRun) {
    console.error(
      `[dry-run] Would record ${key} in ${filePath}'s frontmatter`,
    );
  } else {
    fs.writeFileSync(filePath, stringifyFrontmatter(data, content));
    console.error(`Recorded ${key} in ${filePath}'s frontmatter`);
  }

  return answer;
}

export async function push(
  filePath: string,
  readClient: NotionAPI,
  config: SyncConfig,
  options: SyncOptions,
): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = parseFrontmatter(raw);

  let input = data.notion_url ?? data.notion_id;
  if (!input) {
    // promptForPageRef mutates `data` in place with the new page reference, so
    // the shadow we write below (built from `data`) already carries it.
    input = await promptForPageRef(filePath, data, content, options);
  }

  const pageId = extractPageId(input);
  if (options.verbose) console.log(`  Page ID: ${pageId}`);

  const allBlocks = markdownToBlocks(content);

  // First H1 is the page title — extract it from content blocks
  let pageTitle: string | undefined;
  let blocks = allBlocks;
  if (allBlocks.length > 0 && allBlocks[0].type === "header") {
    const titleDecs = allBlocks[0].properties?.title as [string, ...unknown[]][] | undefined;
    pageTitle = titleDecs?.map((d) => d[0]).join("");
    blocks = allBlocks.slice(1);
  }

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
      // Reconstruct the remote body exactly as pull writes it to the shadow:
      // the page title is rendered as a leading `# title` H1, which
      // recordMapToMarkdown (content blocks only) does not include. Comparing
      // without it makes every titled page look "changed" since last sync.
      const remoteTitle = recordMapToTitle(recordMap, pageId);
      const remoteBodyBlocks = recordMapToMarkdown(recordMap, pageId);
      const remoteBody = remoteTitle
        ? `# ${remoteTitle}\n\n${remoteBodyBlocks}`
        : remoteBodyBlocks;
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

  // Update the page title from the first H1
  if (pageTitle) {
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: ["properties", "title"],
      command: "set",
      args: [[pageTitle]],
    });
  }

  await submitTransaction(config.tokenV2, spaceId, ops);

  writeShadow(filePath, raw);
  console.log(`Pushed: ${filePath} (${totalBlocks} blocks)`);
}
