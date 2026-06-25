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
notion-sync sync pull docs/*.md
notion-sync sync pull docs/*.md --dry-run   # preview only
notion-sync sync pull docs/*.md --force     # overwrite local, skip merge
notion-sync sync pull docs/*.md --verbose
```

### Push

Push local Markdown changes to Notion:

```bash
notion-sync sync push docs/*.md
notion-sync sync push docs/*.md --dry-run   # preview only
notion-sync sync push docs/*.md --force     # overwrite remote, skip change check
notion-sync sync push docs/*.md --verbose
```

## How it works

**Pull** fetches the Notion page, converts blocks to Markdown, and performs a three-way merge against the shadow file (last synced state). If both local and remote changed, it attempts automatic merge or falls back to conflict markers / an external merge tool.

**Push** parses local Markdown into a block tree, diffs against existing Notion blocks using LCS matching, and submits minimal update operations. Block IDs are preserved where content is unchanged, keeping inline comments intact.

Shadow files in `.notion-sync/shadow/` track the last synchronized state to enable merge-base comparison.

## Configuration

Optional `.notion-sync.json`:

```json
{
  "token_v2": "...",
  "mergeTool": "meld $LOCAL $REMOTE $MERGED"
}
```

The `mergeTool` field supports `$BASE`, `$LOCAL`, `$REMOTE`, and `$MERGED` placeholders.

## Development

```bash
yarn dev -- sync pull docs/*.md   # run without building
yarn typecheck                     # type check
yarn test                          # run tests
```

## Tests

- **Unit tests** (`test/diff.test.ts`) — block fingerprinting, change detection, LCS matching, comment mark transplantation
- **E2E tests** (`test/e2e.test.ts`) — full pull/edit/push cycle verifying comment preservation (requires `NOTION_TOKEN_V2` and `NOTION_TEST_PAGE` env vars)

## License

[MIT](LICENSE)
