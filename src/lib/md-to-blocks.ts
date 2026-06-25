import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent, TableRow, TableCell, ListItem } from "mdast";
import type { BlockRecord } from "./blocks.js";

type Decoration = [string] | [string, unknown[][]];

const parser = unified().use(remarkParse).use(remarkGfm);

export function markdownToBlocks(markdown: string): BlockRecord[] {
  const tree = parser.parse(markdown) as Root;
  const blocks: BlockRecord[] = [];
  let i = 0;
  while (i < tree.children.length) {
    const node = tree.children[i];
    if (node.type === "html") {
      const toggleResult = tryParseToggle(node, tree.children, i);
      if (toggleResult) {
        blocks.push(toggleResult.block);
        i = toggleResult.nextIndex;
        continue;
      }
    }
    blocks.push(...nodeToBlocks(node));
    i++;
  }
  return blocks;
}

function nodeToBlocks(node: RootContent): BlockRecord[] {
  switch (node.type) {
    case "heading":
      return [
        block(
          headingType(node.depth),
          titleProp(phrasingToDecorations(node.children)),
        ),
      ];

    case "paragraph":
      // Check for standalone image
      if (
        node.children.length === 1 &&
        node.children[0].type === "image"
      ) {
        const img = node.children[0];
        return [
          block("image", undefined, {
            display_source: img.url,
            block_width: 700,
            block_page_width: true,
          }),
        ];
      }
      return [
        block("text", titleProp(phrasingToDecorations(node.children))),
      ];

    case "blockquote":
      return blockquoteToBlocks(node.children as RootContent[]);

    case "list":
      return node.children.flatMap((item: ListItem) => {
        const type = node.ordered
          ? "numbered_list"
          : item.checked != null
            ? "to_do"
            : "bulleted_list";

        const inlineNodes: PhrasingContent[] = [];
        const childBlocks: BlockRecord[] = [];

        for (const child of item.children) {
          if (child.type === "paragraph") {
            inlineNodes.push(...child.children);
          } else if (child.type === "list") {
            childBlocks.push(...nodeToBlocks(child));
          }
        }

        const props: Record<string, unknown> = {
          title: phrasingToDecorations(inlineNodes),
        };
        if (type === "to_do") {
          props.checked = item.checked ? [["Yes"]] : [["No"]];
        }

        const rec = block(type, props);
        if (childBlocks.length > 0) rec.children = childBlocks;
        return [rec];
      });

    case "code":
      return [
        block(
          "code",
          {
            title: [[node.value]],
            language: [[node.lang ?? "plain text"]],
          },
        ),
      ];

    case "thematicBreak":
      return [block("divider")];

    case "table":
      return [tableToBlock(node.children)];

    case "html": {
      // Toggles are handled by tryParseToggle at the top level;
      // standalone </details> tags consumed by toggle parsing can be ignored
      if (node.value.trim() === "</details>") return [];
      // Other HTML — render as text
      return [block("text", titleProp([[node.value]]))];
    }

    default: {
      // Handle remark-math nodes (math / inlineMath) and unknown types
      const n = node as { type: string; value?: string };
      if (n.type === "math" && n.value) {
        return [block("equation", titleProp([[n.value]]))];
      }
      return [];
    }
  }
}

// --- Toggle (<details>/<summary>) ---

function tryParseToggle(
  node: RootContent,
  siblings: RootContent[],
  index: number,
): { block: BlockRecord; nextIndex: number } | null {
  if (node.type !== "html") return null;

  const value = (node as { value: string }).value;
  const toggleMatch = value.match(
    /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*)/,
  );
  if (!toggleMatch) return null;

  const summaryRaw = toggleMatch[1];
  const afterSummary = toggleMatch[2];

  // Parse summary text (handles both HTML tags and markdown formatting)
  const titleDecs = parseSummaryContent(summaryRaw);

  const children: BlockRecord[] = [];
  let nextIndex = index + 1;

  // Check if body content exists in the same HTML node (no blank line case)
  const closingIdx = afterSummary.indexOf("</details>");
  if (closingIdx !== -1) {
    // Everything between </summary> and </details> is the body
    const bodyText = afterSummary.slice(0, closingIdx).trim();
    if (bodyText) {
      children.push(...markdownToBlocks(bodyText));
    }
  } else {
    // Body is in subsequent sibling nodes until </details>
    while (nextIndex < siblings.length) {
      const sibling = siblings[nextIndex];
      if (
        sibling.type === "html" &&
        (sibling as { value: string }).value.trim() === "</details>"
      ) {
        nextIndex++;
        break;
      }
      children.push(...nodeToBlocks(sibling));
      nextIndex++;
    }
  }

  const rec = block("toggle", titleProp(titleDecs));
  if (children.length > 0) rec.children = children;
  return { block: rec, nextIndex };
}

function parseSummaryContent(raw: string): Decoration[] {
  // Convert HTML formatting tags to markdown equivalents so remark can parse them
  const md = raw
    .replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**")
    .replace(/<b>([\s\S]*?)<\/b>/g, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
    .replace(/<i>([\s\S]*?)<\/i>/g, "*$1*")
    .replace(/<del>([\s\S]*?)<\/del>/g, "~~$1~~")
    .replace(/<s>([\s\S]*?)<\/s>/g, "~~$1~~")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)");

  // Parse the converted string as markdown to extract decorations
  const tree = parser.parse(md) as Root;
  if (
    tree.children.length > 0 &&
    tree.children[0].type === "paragraph"
  ) {
    return phrasingToDecorations(
      (tree.children[0] as { children: PhrasingContent[] }).children,
    );
  }
  // Fallback: plain text
  return [[raw]];
}

function blockquoteToBlocks(children: RootContent[]): BlockRecord[] {
  // Collect all inline content from paragraph children
  const inlines: PhrasingContent[] = [];
  const nested: BlockRecord[] = [];

  for (const child of children) {
    if (child.type === "paragraph") {
      if (inlines.length > 0) inlines.push({ type: "text", value: "\n" });
      inlines.push(...child.children);
    } else {
      nested.push(...nodeToBlocks(child as RootContent));
    }
  }

  const rec = block("quote", titleProp(phrasingToDecorations(inlines)));
  if (nested.length > 0) rec.children = nested;
  return [rec];
}

// --- Table ---

function tableToBlock(rows: TableRow[]): BlockRecord {
  const tableRowBlocks: BlockRecord[] = rows.map((row) => {
    const props: Record<string, unknown> = {};
    row.children.forEach((cell: TableCell, i: number) => {
      const decs = phrasingToDecorations(cell.children);
      props[String.fromCharCode(97 + i)] = decs; // 'a', 'b', 'c', ...
    });
    return block("table_row", props);
  });

  const colCount = rows[0]?.children.length ?? 0;

  const rec = block("table", undefined, {
    table_block_column_order: Array.from({ length: colCount }, (_, i) =>
      String.fromCharCode(97 + i),
    ),
    table_block_column_format: {},
    table_block_column_header: true,
  });
  rec.children = tableRowBlocks;
  return rec;
}

// --- Rich text / Decorations ---

function phrasingToDecorations(nodes: PhrasingContent[]): Decoration[] {
  const result: Decoration[] = [];
  for (const node of nodes) {
    result.push(...phrasingNodeToDec(node));
  }
  return result;
}

function phrasingNodeToDec(
  node: PhrasingContent,
  parentFormats: unknown[][] = [],
): Decoration[] {
  switch (node.type) {
    case "text":
      return parentFormats.length > 0
        ? [[node.value, parentFormats]]
        : [[node.value]];

    case "strong":
      return node.children.flatMap((c: PhrasingContent) =>
        phrasingNodeToDec(c, [...parentFormats, ["b"]]),
      );

    case "emphasis":
      return node.children.flatMap((c: PhrasingContent) =>
        phrasingNodeToDec(c, [...parentFormats, ["i"]]),
      );

    case "delete":
      return node.children.flatMap((c: PhrasingContent) =>
        phrasingNodeToDec(c, [...parentFormats, ["s"]]),
      );

    case "inlineCode":
      return parentFormats.length > 0
        ? [[node.value, [...parentFormats, ["c"]]]]
        : [[node.value, [["c"]]]];

    case "link":
      return node.children.flatMap((c: PhrasingContent) =>
        phrasingNodeToDec(c, [
          ...parentFormats,
          ["a", node.url],
        ]),
      );

    case "image":
      // Inline image as a link
      return [
        [
          node.alt ?? "",
          [...parentFormats, ["a", node.url]],
        ],
      ];

    case "html":
      return [[node.value]];

    case "break":
      return [["\n"]];

    default: {
      // Handle remark-math nodes (inlineMath) and unknown types
      const n = node as { type: string; value?: string };
      if (n.type === "inlineMath" && n.value) {
        return [[n.value, [["e", n.value]]]];
      }
      return [];
    }
  }
}

// --- Helpers ---

function headingType(depth: number): string {
  if (depth === 1) return "header";
  if (depth === 2) return "sub_header";
  return "sub_sub_header";
}

function titleProp(decs: Decoration[]): Record<string, unknown> {
  return { title: decs };
}

function block(
  type: string,
  properties?: Record<string, unknown>,
  format?: Record<string, unknown>,
): BlockRecord {
  return {
    id: crypto.randomUUID(),
    type,
    properties,
    format,
  };
}
