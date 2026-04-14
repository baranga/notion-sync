import type { ExtendedRecordMap, Block, Decoration } from "notion-types";
import { getBlockValue } from "notion-utils";

export function recordMapToMarkdown(
  recordMap: ExtendedRecordMap,
  pageId: string,
): string {
  const pageBlock = getBlockValue(recordMap.block[pageId]) as Block | undefined;
  if (!pageBlock) return "";

  const childIds = pageBlock.content ?? [];
  const lines: string[] = [];

  for (const childId of childIds) {
    const block = getBlockValue(recordMap.block[childId]) as Block | undefined;
    if (!block || !block.alive) continue;
    renderBlock(block, recordMap, lines, 0);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// --- Rich text ---

function decorationsToMarkdown(decorations?: Decoration[]): string {
  if (!decorations) return "";
  return decorations.map(decorationToMarkdown).join("");
}

function decorationToMarkdown(dec: Decoration): string {
  const text = dec[0];
  const formats = dec.length > 1 ? (dec[1] as unknown[][]) : [];

  if (formats.length === 0) return text;

  let result = text;

  // Apply formatting inside-out
  for (const fmt of formats) {
    const tag = fmt[0] as string;
    switch (tag) {
      case "b":
        result = `**${result}**`;
        break;
      case "i":
        result = `*${result}*`;
        break;
      case "s":
        result = `~~${result}~~`;
        break;
      case "c":
        result = `\`${result}\``;
        break;
      case "_":
        // underline — no native md, use HTML
        result = `<u>${result}</u>`;
        break;
      case "a":
        result = `[${result}](${fmt[1] as string})`;
        break;
      case "e":
        // inline equation
        result = `$${fmt[1] as string}$`;
        break;
      case "h":
        // highlight/color — no md equivalent, skip
        break;
      case "m":
      case "u":
      case "p":
        // mention/user/page — just keep the text
        break;
      default:
        break;
    }
  }

  return result;
}

// --- Block rendering ---

function renderBlock(
  block: Block,
  recordMap: ExtendedRecordMap,
  lines: string[],
  indent: number,
): void {
  const prefix = "  ".repeat(indent);
  const title = () => decorationsToMarkdown(block.properties?.title);

  switch (block.type) {
    case "text":
      lines.push(prefix + title());
      lines.push("");
      break;

    case "header":
      lines.push(`# ${title()}`);
      lines.push("");
      break;

    case "sub_header":
      lines.push(`## ${title()}`);
      lines.push("");
      break;

    case "sub_sub_header":
      lines.push(`### ${title()}`);
      lines.push("");
      break;

    case "bulleted_list":
      lines.push(`${prefix}- ${title()}`);
      renderChildren(block, recordMap, lines, indent + 1);
      break;

    case "numbered_list":
      lines.push(`${prefix}1. ${title()}`);
      renderChildren(block, recordMap, lines, indent + 1);
      break;

    case "to_do": {
      const checked = block.properties?.checked?.[0]?.[0] === "Yes";
      lines.push(`${prefix}- [${checked ? "x" : " "}] ${title()}`);
      renderChildren(block, recordMap, lines, indent + 1);
      break;
    }

    case "toggle":
      lines.push(`<details>`);
      lines.push(`<summary>${title()}</summary>`);
      lines.push("");
      renderChildren(block, recordMap, lines, 0);
      lines.push(`</details>`);
      lines.push("");
      break;

    case "quote":
      for (const line of title().split("\n")) {
        lines.push(`> ${line}`);
      }
      renderChildren(block, recordMap, lines, indent, "> ");
      lines.push("");
      break;

    case "callout": {
      const icon = block.format?.page_icon ?? "";
      const text = title();
      lines.push(`> ${icon} **Callout**`);
      lines.push(`>`);
      for (const line of text.split("\n")) {
        lines.push(`> ${line}`);
      }
      renderChildren(block, recordMap, lines, indent, "> ");
      lines.push("");
      break;
    }

    case "code": {
      const language = block.properties?.language?.[0]?.[0] ?? "";
      lines.push(`\`\`\`${language.toLowerCase()}`);
      lines.push(title());
      lines.push("```");
      lines.push("");
      break;
    }

    case "equation": {
      const expr = block.properties?.title?.[0]?.[0] ?? "";
      lines.push(`$$`);
      lines.push(expr);
      lines.push(`$$`);
      lines.push("");
      break;
    }

    case "divider":
      lines.push("---");
      lines.push("");
      break;

    case "image": {
      const src = block.format?.display_source ?? block.properties?.source?.[0]?.[0] ?? "";
      const caption = decorationsToMarkdown(block.properties?.caption);
      const signedUrl = recordMap.signed_urls?.[block.id];
      const url = signedUrl ?? src;
      lines.push(`![${caption}](${url})`);
      lines.push("");
      break;
    }

    case "bookmark": {
      const url = block.properties?.link?.[0]?.[0] ?? "";
      const bookmarkTitle = title() || url;
      lines.push(`[${bookmarkTitle}](${url})`);
      lines.push("");
      break;
    }

    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const src =
        block.format?.display_source ??
        block.properties?.source?.[0]?.[0] ??
        "";
      const signedUrl = recordMap.signed_urls?.[block.id];
      const url = signedUrl ?? src;
      const caption = title() || block.type;
      lines.push(`[${caption}](${url})`);
      lines.push("");
      break;
    }

    case "table": {
      renderTable(block, recordMap, lines);
      lines.push("");
      break;
    }

    case "column_list":
      // Render columns sequentially — no way to represent side-by-side in MD
      renderChildren(block, recordMap, lines, indent);
      break;

    case "column":
      renderChildren(block, recordMap, lines, indent);
      break;

    case "page": {
      // Sub-page — render as a link
      const pageTitle = title() || "Untitled";
      lines.push(`[${pageTitle}](https://www.notion.so/${block.id.replace(/-/g, "")})`);
      lines.push("");
      break;
    }

    case "embed":
    case "gist":
    case "figma":
    case "tweet":
    case "maps":
    case "codepen":
    case "replit": {
      const src = block.format?.display_source ?? block.properties?.source?.[0]?.[0] ?? "";
      lines.push(`[${block.type}: ${src}](${src})`);
      lines.push("");
      break;
    }

    default: {
      // Unknown block — try to render title if present
      const text = title();
      if (text) {
        lines.push(prefix + text);
        lines.push("");
      }
      break;
    }
  }
}

function renderChildren(
  block: Block,
  recordMap: ExtendedRecordMap,
  lines: string[],
  indent: number,
  linePrefix?: string,
): void {
  const childIds = block.content ?? [];
  if (childIds.length === 0) return;

  for (const childId of childIds) {
    const child = getBlockValue(recordMap.block[childId]) as Block | undefined;
    if (!child || !child.alive) continue;

    if (linePrefix) {
      const childLines: string[] = [];
      renderBlock(child, recordMap, childLines, indent);
      for (const line of childLines) {
        lines.push(line ? linePrefix + line : line);
      }
    } else {
      renderBlock(child, recordMap, lines, indent);
    }
  }
}

function renderTable(
  block: Block,
  recordMap: ExtendedRecordMap,
  lines: string[],
): void {
  const rowIds = block.content ?? [];
  if (rowIds.length === 0) return;

  const rows: string[][] = [];
  for (const rowId of rowIds) {
    const rowBlock = getBlockValue(recordMap.block[rowId]) as Block | undefined;
    if (!rowBlock || rowBlock.type !== "table_row") continue;

    const props = rowBlock.properties ?? {};
    const cells: string[] = [];
    // Table row properties are keyed by column index as strings
    const keys = Object.keys(props).sort();
    for (const key of keys) {
      cells.push(decorationsToMarkdown(props[key]));
    }
    rows.push(cells);
  }

  if (rows.length === 0) return;

  const colCount = Math.max(...rows.map((r) => r.length));

  // Pad rows to equal length
  for (const row of rows) {
    while (row.length < colCount) row.push("");
  }

  // Header row
  lines.push(`| ${rows[0].join(" | ")} |`);
  lines.push(`| ${rows[0].map(() => "---").join(" | ")} |`);

  // Data rows
  for (let i = 1; i < rows.length; i++) {
    lines.push(`| ${rows[i].join(" | ")} |`);
  }
}
