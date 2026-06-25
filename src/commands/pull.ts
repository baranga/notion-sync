import fs from "node:fs";
import type { NotionAPI } from "notion-client";
import type { Block, ExtendedRecordMap } from "notion-types";
import { parseFrontmatter, stringifyFrontmatter } from "../lib/frontmatter.js";
import { extractPageId } from "../lib/id.js";
import { fetchPage } from "../lib/notion.js";
import { recordMapToMarkdown } from "../lib/recordmap-to-md.js";
import { readShadow, writeShadow } from "../lib/shadow.js";
import { threeWayMerge, invokeExternalTool } from "../lib/merge.js";
import type { SyncConfig, SyncOptions } from "../types.js";

function getPageTitle(recordMap: ExtendedRecordMap, pageId: string): string | undefined {
  const entry = recordMap.block[pageId];
  if (!entry) return undefined;
  const block = (
    "value" in entry
      ? (entry.value && typeof entry.value === "object" && "value" in entry.value
        ? (entry.value as { value: Block }).value
        : entry.value)
      : entry
  ) as Block;
  const titleDecs = block?.properties?.title;
  if (!titleDecs || !Array.isArray(titleDecs)) return undefined;
  return titleDecs.map((d: unknown[]) => d[0]).join("");
}

export async function pull(
  filePath: string,
  client: NotionAPI,
  config: SyncConfig,
  options: SyncOptions,
): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content: localBody } = parseFrontmatter(raw);

  const input = data.notion_url ?? data.notion_id;
  if (!input) {
    throw new Error(
      `${filePath}: frontmatter missing notion_url or notion_id`,
    );
  }

  const pageId = extractPageId(input);
  if (options.verbose) console.log(`  Page ID: ${pageId}`);

  const recordMap = await fetchPage(client, pageId);

  const title = getPageTitle(recordMap, pageId);
  delete data.title; // title lives as H1 in content, not frontmatter

  const bodyFromBlocks = recordMapToMarkdown(recordMap, pageId);
  const remoteBody = title ? `# ${title}\n\n${bodyFromBlocks}` : bodyFromBlocks;
  const remoteOutput = stringifyFrontmatter(data, remoteBody);

  if (options.dryRun) {
    console.log(`[dry-run] Would pull ${filePath}`);
    if (options.verbose) console.log(remoteOutput);
    return;
  }

  // --force: overwrite and save shadow
  if (options.force) {
    fs.writeFileSync(filePath, remoteOutput, "utf-8");
    writeShadow(filePath, remoteOutput);
    console.log(`Pulled: ${filePath}`);
    return;
  }

  const shadow = readShadow(filePath);
  const baseBody = shadow ? parseFrontmatter(shadow).content : "";
  const hasShadow = shadow !== null;

  const localUnchanged = localBody === baseBody;
  const remoteUnchanged = remoteBody === baseBody;

  if (remoteUnchanged) {
    console.log(`Up to date: ${filePath}`);
    return;
  }

  if (localUnchanged) {
    // Fast-forward: only remote changed
    fs.writeFileSync(filePath, remoteOutput, "utf-8");
    writeShadow(filePath, remoteOutput);
    console.log(`Pulled: ${filePath}`);
    return;
  }

  // Both changed — merge on body only
  const mergeKind = hasShadow ? "three-way" : "two-way";
  if (options.verbose) console.log(`  Both local and remote differ, ${mergeKind} merge…`);

  const { content: mergedBody, hasConflicts } = threeWayMerge(baseBody, localBody, remoteBody);

  if (!hasConflicts) {
    const output = stringifyFrontmatter(data, mergedBody);
    fs.writeFileSync(filePath, output, "utf-8");
    writeShadow(filePath, remoteOutput);
    console.log(`Merged: ${filePath}`);
    return;
  }

  // Conflicts — try external merge tool
  if (config.mergeTool) {
    if (options.verbose) console.log(`  Invoking merge tool: ${config.mergeTool}`);

    const result = invokeExternalTool(
      config.mergeTool,
      stringifyFrontmatter(data, baseBody),
      raw,
      remoteOutput,
    );

    if (result !== null) {
      fs.writeFileSync(filePath, result, "utf-8");
      writeShadow(filePath, remoteOutput);
      console.log(`Merged (external): ${filePath}`);
      return;
    }

    console.warn(`  Merge tool exited with error, falling back to conflict markers`);
  }

  // No merge tool or tool failed — write conflict markers
  const output = stringifyFrontmatter(data, mergedBody);
  fs.writeFileSync(filePath, output, "utf-8");
  writeShadow(filePath, remoteOutput);
  console.warn(`Conflicts: ${filePath} — resolve manually`);
}
