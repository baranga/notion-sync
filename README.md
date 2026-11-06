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

If `diffTool` is set in the config, it's used to display differences instead of the built-in unified diff. By default it receives `$LOCAL` and `$REMOTE`, plus `$BASE` when a shadow file exists. A three-way-capable tool can use all three to show local and remote changes side by side; the `kdiff3`, `meld`, `vimdiff` and `p4merge` presets do this automatically. With `--local`/`--remote`, the tool is invoked as a plain two-way diff of that side against the base.

## How it works

**Pull** fetches the Notion page, converts blocks to Markdown, and performs a three-way merge against the shadow file (last synced state). If both local and remote changed, it attempts automatic merge or falls back to conflict markers / an external merge tool.

**Push** parses local Markdown into a block tree, diffs against existing Notion blocks using LCS matching, and submits minimal update operations. Block IDs are preserved where content is unchanged, keeping inline comments intact.

Shadow files in `.notion-sync/shadow/` track the last synchronized state to enable merge-base comparison.

## Configuration

Optional `.notion-sync.json`:

```json
{
  "tokenV2": "...",
  "mergeTool": "kdiff3",
  "diffTool": "kdiff3"
}
```

`mergeTool` and `diffTool` are either the name of a built-in preset or a custom shell command.

**Presets** (invocations modelled on `git mergetool`): `kdiff3`, `meld`, `vimdiff`, `nvimdiff`, `gvimdiff`, `code` (alias `vscode`), `bc` (Beyond Compare, aliases `bc3`/`bc4`), `p4merge`, and `smerge` (merge only). Presets give each pane a descriptive title wherever the tool supports it (kdiff3, meld, Beyond Compare, p4merge), for example:

| Pane   | Title                                          |
| ------ | ---------------------------------------------- |
| Base   | `base: last sync 2026-11-01 09:12`             |
| Local  | `local: docs/notes.md`                         |
| Remote | `notion: "Meeting notes", edited 2026-11-05 14:03` |
| Output | `merged: docs/notes.md`                        |

Without a shadow file, the merge is two-way (local vs. remote, no base pane). Temp files are named after the synced file (`notes.BASE.md`, `notes.LOCAL.md`, `notes.REMOTE.md`, and `notes.md` for the output), so tools that only show file names (vimdiff, VS Code) still show what is being merged. The output file starts out as the automatic merge with conflict markers, so editors that open it directly show both sides of each conflict. If the tool exits without changing it, or exits non-zero, `pull` keeps the conflict markers in the local file.

**Custom commands** run through the shell. `mergeTool` supports `$BASE`, `$LOCAL`, `$REMOTE`, and `$MERGED` placeholders. `$BASE` is an empty file before the first sync. `diffTool` supports `$LOCAL` and `$REMOTE`, plus `$BASE` once a shadow file exists. The pane titles are available as the environment variables `$BASE_LABEL`, `$LOCAL_LABEL`, `$REMOTE_LABEL` and `$MERGED_LABEL` (POSIX shells), e.g.:

```bash
notion-sync config set mergeTool 'kdiff3 --auto --L1 "$BASE_LABEL" --L2 "$LOCAL_LABEL" --L3 "$REMOTE_LABEL" -o $MERGED $BASE $LOCAL $REMOTE'
```

When no merge tool is configured or the tool doesn't resolve the merge, conflicts are written as diff3-style markers that include the base version, using the same titles:

```
<<<<<<< local: docs/notes.md
our edit
||||||| base: last sync 2026-11-01 09:12
original text
=======
their edit
>>>>>>> notion: "Meeting notes", edited 2026-11-05 14:03
```

Rather than editing the file directly, you can manage these with the `config` subcommand:

```bash
notion-sync config set mergeTool kdiff3
notion-sync config set diffTool 'meld $LOCAL $REMOTE'
notion-sync config get                # show all configurable values
notion-sync config get diffTool       # show one value
notion-sync config unset diffTool
```

By default these write to the home config (`~/.config/notion-sync/config.json`); pass `--local` to write to `./.notion-sync.json` in the current project instead:

```bash
notion-sync config set mergeTool kdiff3 --local
```

## Development

```bash
yarn dev pull docs/*.md   # run without building
yarn typecheck            # type check
yarn test                 # run tests
```

## Tests

- **Unit tests** (`test/diff.test.ts`) — block fingerprinting, change detection, LCS matching, comment mark transplantation
- **Merge/tool tests** (`test/merge.test.ts`) — conflict markers, merge/diff tool presets and custom commands (via fake tools on `PATH`)
- **E2E tests** (`test/e2e.test.ts`) — full pull/edit/push cycle verifying comment preservation (requires `NOTION_TOKEN_V2` and `NOTION_TEST_PAGE` env vars)

## License

[MIT](LICENSE)
