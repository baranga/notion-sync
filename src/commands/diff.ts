import fs from "node:fs";
import type { NotionAPI } from "notion-client";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { extractPageId } from "../lib/id.js";
import { fetchPage } from "../lib/notion.js";
import { renderRemoteBody } from "../lib/recordmap-to-md.js";
import { readShadow } from "../lib/shadow.js";
import { invokeExternalDiffTool, unifiedDiff } from "../lib/text-diff.js";
import type { SyncConfig, SyncOptions } from "../types.js";

/**
 * Which side(s) of a three-way diff to show: local edits vs. the shadow
 * base, remote edits vs. the base, or both (default).
 */
export type DiffMode = "local" | "remote" | "both";

/**
 * Show the difference between a local file's body and the current Notion
 * page content, without writing anything. Returns whether any diff was found.
 *
 * When a shadow file (last-synced base) is available, this is a three-way
 * diff: local and remote are each compared against the base, so it's clear
 * which changes came from local edits vs. remote edits — mirroring the
 * base/local/remote comparison `pull`'s three-way merge uses. `mode` selects
 * which side(s) to show. Without a shadow (nothing pulled/pushed yet), only
 * `mode: "both"` (the default) is valid, and it falls back to a plain
 * local-vs-remote diff.
 */
export async function diff(
  filePath: string,
  client: NotionAPI,
  config: SyncConfig,
  options: SyncOptions,
  mode: DiffMode = "both",
): Promise<boolean> {
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
  const remoteBody = renderRemoteBody(recordMap, pageId);

  const shadow = readShadow(filePath);
  const baseBody = shadow ? parseFrontmatter(shadow).content : undefined;

  if (baseBody === undefined) {
    if (mode !== "both") {
      throw new Error(
        `${filePath}: no shadow/base found (nothing pulled/pushed yet) — ` +
          `--${mode} needs a synced base to diff against. Pull the file first, ` +
          `or omit --local/--remote for a plain local-vs-remote diff.`,
      );
    }

    // No shadow yet — nothing to compare each side against individually, so
    // just show local vs. remote directly.
    const { hasChanges, text } = unifiedDiff(
      `${filePath} (local)`,
      `${filePath} (notion)`,
      localBody,
      remoteBody,
    );

    if (!hasChanges) {
      console.log(`No changes: ${filePath}`);
      return false;
    }

    if (config.diffTool) {
      if (options.verbose) console.log(`  Invoking diff tool: ${config.diffTool}`);
      if (invokeExternalDiffTool(config.diffTool, localBody, remoteBody)) {
        return true;
      }
      console.warn(`  Diff tool failed to launch, falling back to built-in diff`);
    }

    console.log(text);
    return true;
  }

  const localDiff =
    mode !== "remote"
      ? unifiedDiff(`${filePath} (base)`, `${filePath} (local)`, baseBody, localBody)
      : null;
  const remoteDiff =
    mode !== "local"
      ? unifiedDiff(`${filePath} (base)`, `${filePath} (notion)`, baseBody, remoteBody)
      : null;

  if (!localDiff?.hasChanges && !remoteDiff?.hasChanges) {
    console.log(`No changes: ${filePath}`);
    return false;
  }

  if (config.diffTool) {
    if (options.verbose) console.log(`  Invoking diff tool: ${config.diffTool}`);

    const ok =
      mode === "both"
        ? invokeExternalDiffTool(config.diffTool, localBody, remoteBody, baseBody)
        : mode === "local"
          ? invokeExternalDiffTool(config.diffTool, localBody, baseBody)
          : invokeExternalDiffTool(config.diffTool, baseBody, remoteBody);

    if (ok) return true;
    console.warn(`  Diff tool failed to launch, falling back to built-in diff`);
  }

  if (localDiff?.hasChanges) {
    console.log(`-- Local changes (since last sync): ${filePath} --`);
    console.log(localDiff.text);
  }
  if (remoteDiff?.hasChanges) {
    if (localDiff?.hasChanges) console.log();
    console.log(`-- Remote changes (since last sync): ${filePath} --`);
    console.log(remoteDiff.text);
  }
  return true;
}
