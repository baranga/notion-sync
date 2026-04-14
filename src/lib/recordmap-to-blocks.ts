import type { Block, ExtendedRecordMap } from "notion-types";
import { getBlockValue } from "notion-utils";
import type { BlockRecord } from "./blocks.js";

/**
 * Extract BlockRecord[] from a Notion ExtendedRecordMap,
 * preserving real Notion block IDs.
 */
export function extractBlocks(
  recordMap: ExtendedRecordMap,
  pageId: string,
): BlockRecord[] {
  const page = getBlockValue(recordMap.block[pageId]) as Block | undefined;
  if (!page) return [];

  const childIds = page.content ?? [];
  return childIds.flatMap((id) => blockToRecord(recordMap, id));
}

function blockToRecord(
  recordMap: ExtendedRecordMap,
  blockId: string,
): BlockRecord[] {
  const block = getBlockValue(recordMap.block[blockId]) as Block | undefined;
  if (!block || !block.alive) return [];

  const rec: BlockRecord = {
    id: block.id,
    type: block.type,
    properties: block.properties,
    format: block.format,
  };

  if (block.content && block.content.length > 0) {
    rec.children = block.content.flatMap((id) => blockToRecord(recordMap, id));
  }

  return [rec];
}
