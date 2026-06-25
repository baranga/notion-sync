# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

notion-sync is a bidirectional sync tool between Notion pages and local Markdown files. It pulls Notion pages into Markdown with frontmatter, supports local editing, and pushes changes back using block-level diffing with LCS-based matching to preserve inline comments and block structure. Three-way merge (via shadow files) detects conflicts on pull.

## Commands

- `yarn build` — TypeScript compile + chmod executable (`tsc && chmod +x dist/cli.js`)
- `yarn dev` — Run CLI without building (`tsx src/cli.ts`)
- `yarn typecheck` — Type-check only, no emit (`tsc -p tsconfig.check.json`)
- `yarn test` — Run all tests (`vitest run`)
- `yarn vitest run test/diff.test.ts` — Run a single test file
- `yarn vitest run -t "test name"` — Run a single test by name

E2E tests require `NOTION_TOKEN_V2` and `NOTION_TEST_PAGE` env vars (loaded from `.env.test`).

## Architecture

### Sync Flow

**Pull:** Notion API → RecordMap → BlockRecords → Markdown (with frontmatter) → three-way merge against shadow file → write local file + update shadow.

**Push:** Local Markdown → parse to BlockRecords → diff against existing Notion blocks (LCS matching) → submit minimal transaction operations → update shadow.

### Entry Point & Commands

- **`src/cli.ts`** — Commander entry point. Registers two top-level commands, `pull` and `push` (note: invoked as `notion-sync pull ...`, there is no `sync` subcommand). Resolves glob patterns, loads config, and wraps each file in `withRetry`, which catches `StaleTokenError` and re-prompts for a fresh token once.
- **`src/commands/pull.ts`** / **`src/commands/push.ts`** — Per-file orchestration of the sync flows below. These own the high-level sequencing; `src/lib/` holds the reusable engine.
- **`src/types.ts`** — Shared types: `SyncConfig`, `FileFrontmatter` (`notion_url` / `notion_id`), `SyncOptions` (`dryRun`, `verbose`, `force`).

### Key Modules (`src/lib/`)

- **`diff.ts`** — Core diffing engine. Two-phase LCS block matching (exact fingerprint → type+position fallback). Comment mark transplantation extracts `["m", discussionId]` decorations from old blocks and re-injects them into matched new blocks. Strips Notion-only decoration formats (highlights, mentions, page links) for comparison.
- **`blocks.ts`** — Builds Notion API transaction operations from diffs. Defines `BlockRecord`. Diff-based mode (`buildDiffOperations`) updates only changed blocks; full-replace mode (`buildReplaceOperations`) used with `--force`.
- **`merge.ts`** — Three-way merge using node-diff3. Supports external merge tool via config (`$BASE`, `$LOCAL`, `$REMOTE`, `$MERGED` placeholders).
- **`shadow.ts`** — Manages `.notion-sync/shadow/` files tracking last-synced state (merge base).
- **`recordmap-to-md.ts`** / **`md-to-blocks.ts`** — Bidirectional conversion between Notion block trees and Markdown AST (via remark/unified with GFM).
- **`recordmap-to-blocks.ts`** — Extracts `BlockRecord[]` from a Notion `ExtendedRecordMap`, preserving real Notion block IDs (the IDs that keep comment threads alive across pushes).
- **`frontmatter.ts`** — Thin gray-matter wrapper (`parseFrontmatter` / `stringifyFrontmatter`). The page title lives as the H1 in the body, not in frontmatter.
- **`id.ts`** — `extractPageId`: normalizes a UUID, bare 32-char hex, or Notion URL into a dashed page UUID.
- **`notion.ts`** — Unofficial Notion API client wrapper (`createReadClient`, `fetchPage`, `submitTransaction`) with `StaleTokenError` detection.
- **`config.ts`** — Token resolution: `NOTION_TOKEN_V2` env → `~/.notion-sync.json` → `./.notion-sync.json`. Config files use the camelCase key `tokenV2` (and optional `mergeTool`). Interactively prompts for and persists a token when missing or stale.

### Block Matching & Comment Preservation

The central design challenge is preserving Notion inline comments across edits. Block IDs must be reused for unchanged/modified blocks so comment discussion threads survive. The diff engine fingerprints blocks (type + plain text), runs LCS to find the longest common subsequence of exact matches, then does a secondary pass matching remaining blocks by type and position. Comment marks (`["m"]` decorations) are transplanted from old to new blocks by locating the commented text substring.

### Notion Block Model

Blocks have decoration arrays for rich text: `[["text", [["b"], ["i"]]]]` means bold+italic "text". Notion-only marks (`"h"` highlight/color, `"u"` mention, `"p"` page link, `"m"` comment) are stripped during comparison but preserved/transplanted in output. Tables use letter-keyed columns ('a', 'b', 'c'...). Toggles render as `<details>/<summary>` HTML in Markdown.

## Testing

Unit tests in `test/diff.test.ts` cover block fingerprinting, LCS matching, comment transplantation, and decoration normalization. E2E tests in `test/e2e.test.ts` run a full pull→edit→push cycle against a real Notion page and verify comment preservation. Set `KEEP_TEST_PAGE=1` to skip cleanup. `vitest.config.ts` loads `.env.test` into `process.env` before tests run.
