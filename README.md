# notion-sync

Bidirectional sync between local Markdown files and Notion pages. Pull Notion content into Markdown, edit locally, and push changes back — with three-way merge and comment preservation.

## Features

- **Pull & Push** — fetch Notion pages as Markdown, push local edits back
- **Three-way merge** — detects conflicts when both local and remote change; supports external merge tools
- **Comment preservation** — inline Notion comments survive pull/edit/push cycles
- **Smart diffing** — LCS-based block matching generates minimal Notion API operations and preserves block IDs
- **Rich content** — headers, lists, code blocks, tables, images, callouts, toggles, embeds, and more
- **Glob patterns** — sync multiple files at once
- **Dry-run mode** — preview changes before applying

## Setup

```bash
yarn install
yarn build
```

You need a Notion `token_v2` cookie. The CLI will prompt you interactively if one isn't configured. Tokens are resolved in this order:

1. `NOTION_TOKEN_V2` environment variable
2. `~/.notion-sync.json`
3. `.notion-sync.json` (local project config)

## Usage

Each Markdown file needs frontmatter with a `notion_url` or `notion_id` pointing to the Notion page:

```markdown
---
notion_url: https://www.notion.so/My-Page-abc123...
---

# My Page

Content here...
```

### Pull

Fetch Notion page content into local Markdown files:

```bash
notion-sync pull docs/*.md
notion-sync pull docs/*.md --dry-run   # preview only
notion-sync pull docs/*.md --force     # overwrite local, skip merge
notion-sync pull docs/*.md --verbose
```

### Push

Push local Markdown changes to Notion:

```bash
notion-sync push docs/*.md
notion-sync push docs/*.md --dry-run   # preview only
notion-sync push docs/*.md --force     # overwrite remote, skip change check
notion-sync push docs/*.md --verbose
```

### Diff

Preview differences between local Markdown files and their Notion pages, without writing anything:

```bash
notion-sync diff docs/*.md             # three-way: local changes + remote changes
notion-sync diff docs/*.md --local     # only local edits (local vs. base)
notion-sync diff docs/*.md --remote    # only remote edits (Notion vs. base)
notion-sync diff docs/*.md --verbose
```

If a shadow file exists (i.e. the page has been pulled/pushed before), this is a **three-way diff**: local and remote are each compared against the last-synced base, so the output separates local edits from remote edits instead of just showing local vs. remote directly. Pass `--local` or `--remote` to see just one side; both require a shadow file to diff against and error out if the page has never been pulled/pushed. Without a shadow file, the default (no `--local`/`--remote`) falls back to a plain local-vs-remote diff.

If `diffTool` is set in the config, it's used to display differences instead of the built-in unified diff. By default it receives `$LOCAL` and `$REMOTE`, plus `$BASE` when a shadow file exists — a three-way-capable tool (e.g. `meld`) can use all three to show local/remote changes side by side. With `--local`/`--remote`, the tool is invoked as a plain two-way diff of that side against the base.

## How it works

**Pull** fetches the Notion page, converts blocks to Markdown, and performs a three-way merge against the shadow file (last synced state). If both local and remote changed, it attempts automatic merge or falls back to conflict markers / an external merge tool.

**Push** parses local Markdown into a block tree, diffs against existing Notion blocks using LCS matching, and submits minimal update operations. Block IDs are preserved where content is unchanged, keeping inline comments intact.

Shadow files in `.notion-sync/shadow/` track the last synchronized state to enable merge-base comparison.

## Configuration

Optional `.notion-sync.json`:

```json
{
  "tokenV2": "...",
  "mergeTool": "meld $LOCAL $REMOTE $MERGED",
  "diffTool": "meld $BASE $LOCAL $REMOTE"
}
```

The `mergeTool` field supports `$BASE`, `$LOCAL`, `$REMOTE`, and `$MERGED` placeholders. The `diffTool` field supports `$LOCAL` and `$REMOTE` (`$BASE` too, once a shadow file exists).

## Development

```bash
yarn dev pull docs/*.md   # run without building
yarn typecheck            # type check
yarn test                 # run tests
```

## Tests

- **Unit tests** (`test/diff.test.ts`) — block fingerprinting, change detection, LCS matching, comment mark transplantation
- **E2E tests** (`test/e2e.test.ts`) — full pull/edit/push cycle verifying comment preservation (requires `NOTION_TOKEN_V2` and `NOTION_TEST_PAGE` env vars)

## License

[MIT](LICENSE)
