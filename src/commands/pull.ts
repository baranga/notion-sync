import fs from "node:fs";
import type { NotionAPI } from "notion-client";
import type { Block, ExtendedRecordMap } from "notion-types";
import { parseFrontmatter, stringifyFrontmatter } from "../lib/frontmatter.js";
import { extractPageId } from "../lib/id.js";
import { fetchPage } from "../lib/notion.js";
import { recordMapToMarkdown } from "../lib/recordmap-to-md.js";
import { readShadow, writeShadow } from "../lib/shadow.js";
import { threeWayMerge, hasConflictMarkers } from "../lib/merge.js";
import { syncLabels } from "../lib/sync-labels.js";
import { invokeMergeTool, toolName } from "../lib/external-tool.js";
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

  const labels = syncLabels(filePath, recordMap, pageId);
  const { content: mergedBody, hasConflicts, conflicts } = threeWayMerge(
    baseBody,
    localBody,
    remoteBody,
    { labels, showBase: hasShadow },
  );
  const mergedOutput = stringifyFrontmatter(data, mergedBody);

  if (!hasConflicts) {
    fs.writeFileSync(filePath, mergedOutput, "utf-8");
    writeShadow(filePath, remoteOutput);
    console.log(`Merged: ${filePath}`);
    return;
  }

  // Conflicts — try external merge tool
  if (config.mergeTool) {
    const tool = toolName(config.mergeTool);
    console.log(
      `Conflicts: ${filePath} — ${conflicts} conflicting section${conflicts === 1 ? "" : "s"}, opening ${tool}…`,
    );

    const outcome = invokeMergeTool(config.mergeTool, filePath, {
      base: hasShadow ? { content: stringifyFrontmatter(data, baseBody), label: labels.base } : undefined,
      local: { content: raw, label: labels.local },
      remote: { content: remoteOutput, label: labels.remote },
      merged: { content: mergedOutput, label: `merged: ${filePath}` },
    });

    if (outcome.status === "resolved") {
      fs.writeFileSync(filePath, outcome.content, "utf-8");
      writeShadow(filePath, remoteOutput);
      if (hasConflictMarkers(outcome.content)) {
        console.warn(`Conflicts: ${filePath} — ${tool} left conflict markers, resolve manually`);
      } else {
        console.log(`Merged (external): ${filePath}`);
      }
      return;
    }

    console.warn(
      outcome.status === "unresolved"
        ? `  ${tool} exited without saving a merge, falling back to conflict markers`
        : `  ${tool} failed (${outcome.reason}), falling back to conflict markers`,
    );
  }

  // No merge tool or tool failed — write conflict markers
  fs.writeFileSync(filePath, mergedOutput, "utf-8");
  writeShadow(filePath, remoteOutput);
  console.warn(`Conflicts: ${filePath} — resolve manually`);
}
