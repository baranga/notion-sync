#!/usr/bin/env node
import { program } from "commander";
import { glob } from "glob";
import {
  loadConfig,
  handleMissingToken,
  handleStaleToken,
} from "./lib/config.js";
import { createReadClient, StaleTokenError } from "./lib/notion.js";
import { pull } from "./commands/pull.js";
import { push } from "./commands/push.js";
import type { SyncConfig, SyncOptions } from "./types.js";

async function resolveFiles(patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { nodir: true });
    files.push(...matches);
  }
  return [...new Set(files)];
}

async function getConfig(): Promise<SyncConfig> {
  const config = loadConfig();
  if (config) return config;
  return handleMissingToken();
}

async function withRetry<T>(
  config: SyncConfig,
  fn: (conf: SyncConfig) => Promise<T>,
): Promise<T> {
  try {
    return await fn(config);
  } catch (err) {
    if (err instanceof StaleTokenError) {
      const newConfig = await handleStaleToken(config);
      return fn(newConfig);
    }
    throw err;
  }
}

program
  .name("notion-sync")
  .version("0.1.0")
  .description("Sync local Markdown files with Notion pages");

program
  .command("pull")
  .description("Pull Notion page content into local markdown files")
  .argument("<files...>", "Markdown file paths or glob patterns")
  .option("--dry-run", "Preview without writing files", false)
  .option("--verbose", "Show detailed output", false)
  .option("--force", "Skip merge and overwrite local file", false)
  .action(async (filePatterns: string[], opts: SyncOptions) => {
    const config = await getConfig();
    const files = await resolveFiles(filePatterns);

    if (files.length === 0) {
      console.error("No files matched the given patterns.");
      process.exit(1);
    }

    let failed = false;
    for (const file of files) {
      await withRetry(config, async (conf) => {
        const client = createReadClient(conf);
        try {
          await pull(file, client, conf, opts);
        } catch (err) {
          if (err instanceof StaleTokenError) throw err;
          failed = true;
          console.error(
            `Error processing ${file}: ${err instanceof Error ? err.message : err}`,
          );
        }
      });
    }
    if (failed) process.exit(1);
  });

program
  .command("push")
  .description("Push local markdown file content to Notion pages")
  .argument("<files...>", "Markdown file paths or glob patterns")
  .option("--dry-run", "Preview without pushing to Notion", false)
  .option("--verbose", "Show detailed output", false)
  .option("--force", "Skip remote change check and overwrite", false)
  .action(async (filePatterns: string[], opts: SyncOptions) => {
    const config = await getConfig();
    const files = await resolveFiles(filePatterns);

    if (files.length === 0) {
      console.error("No files matched the given patterns.");
      process.exit(1);
    }

    let failed = false;
    for (const file of files) {
      await withRetry(config, async (conf) => {
        const client = createReadClient(conf);
        try {
          await push(file, client, conf, opts);
        } catch (err) {
          if (err instanceof StaleTokenError) throw err;
          failed = true;
          console.error(
            `Error processing ${file}: ${err instanceof Error ? err.message : err}`,
          );
        }
      });
    }
    if (failed) process.exit(1);
  });

program.parse();
