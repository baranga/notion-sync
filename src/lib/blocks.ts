import type { Operation } from "./notion.js";
import {
  matchBlocks,
  needsUpdate,
  propertiesChanged,
  formatChanged,
  mergeCommentMarks,
} from "./diff.js";

export interface BlockRecord {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  format?: Record<string, unknown>;
  children?: BlockRecord[];
}

export function buildReplaceOperations(
  pageId: string,
  spaceId: string,
  existingChildIds: string[],
  newBlocks: BlockRecord[],
): Operation[] {
  const now = Date.now();
  const ops: Operation[] = [];

  // Remove existing children
  for (const childId of existingChildIds) {
    ops.push({
      pointer: { table: "block", id: childId, spaceId },
      path: [],
      command: "update",
      args: { alive: false },
    });
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: ["content"],
      command: "listRemove",
      args: { id: childId },
    });
  }

  // Create new blocks — walk tree depth-first, parent before children
  appendBlockOps(ops, newBlocks, pageId, spaceId, now);

  // Update the page's last_edited_time
  ops.push({
    pointer: { table: "block", id: pageId, spaceId },
    path: [],
    command: "update",
    args: { last_edited_time: now },
  });

  return ops;
}

function appendBlockOps(
  ops: Operation[],
  blocks: BlockRecord[],
  parentId: string,
  spaceId: string,
  now: number,
): void {
  for (const block of blocks) {
    ops.push({
      pointer: { table: "block", id: block.id, spaceId },
      path: [],
      command: "set",
      args: {
        id: block.id,
        version: 1,
        type: block.type,
        properties: block.properties ?? {},
        format: block.format ?? {},
        content: block.children?.map((c) => c.id) ?? [],
        parent_id: parentId,
        parent_table: "block",
        alive: true,
        created_time: now,
        last_edited_time: now,
      },
    });
    ops.push({
      pointer: { table: "block", id: parentId, spaceId },
      path: ["content"],
      command: "listAfter",
      args: { id: block.id },
    });

    if (block.children) {
      appendBlockOps(ops, block.children, block.id, spaceId, now);
    }
  }
}

/**
 * Diff-based operation builder. Compares old (Notion) blocks against new
 * (markdown-derived) blocks and produces minimal operations that preserve
 * existing block IDs — and therefore Notion comments.
 */
export function buildDiffOperations(
  pageId: string,
  spaceId: string,
  oldBlocks: BlockRecord[],
  newBlocks: BlockRecord[],
): Operation[] {
  const now = Date.now();
  const ops: Operation[] = [];

  const { matched, deletions, insertions } = matchBlocks(oldBlocks, newBlocks);

  // Build a map from newIndex → oldBlock ID for matched pairs
  const oldIdByNewIdx = new Map<number, string>();
  for (const [oi, ni] of matched) {
    oldIdByNewIdx.set(ni, oldBlocks[oi].id);
  }

  // --- Deletions: mark unmatched old blocks as dead ---
  for (const oi of deletions) {
    deleteBlockOps(ops, oldBlocks[oi].id, pageId, spaceId);
  }

  // --- Updates: for matched pairs whose content changed ---
  for (const [oi, ni] of matched) {
    const oldB = oldBlocks[oi];
    const newB = newBlocks[ni];

    // Assign the old ID so the block identity is preserved
    newB.id = oldB.id;

    if (needsUpdate(oldB, newB)) {
      updateBlockOps(ops, oldB, newB, spaceId, now);
    }

    // Recurse into children
    if (newB.children || oldB.children) {
      diffChildrenOps(ops, oldB, newB, spaceId, now);
    }
  }

  // --- Insertions: create blocks that have no old match ---
  for (const ni of insertions) {
    createBlockOps(ops, newBlocks[ni], pageId, spaceId, now);
  }

  // --- Rebuild content order on the parent ---
  rebuildContentOrder(ops, pageId, spaceId, oldBlocks, newBlocks);

  // Update page's last_edited_time
  ops.push({
    pointer: { table: "block", id: pageId, spaceId },
    path: [],
    command: "update",
    args: { last_edited_time: now },
  });

  return ops;
}

// --- Helpers -----------------------------------------------------------------

function deleteBlockOps(
  ops: Operation[],
  blockId: string,
  parentId: string,
  spaceId: string,
): void {
  ops.push({
    pointer: { table: "block", id: blockId, spaceId },
    path: [],
    command: "update",
    args: { alive: false },
  });
  ops.push({
    pointer: { table: "block", id: parentId, spaceId },
    path: ["content"],
    command: "listRemove",
    args: { id: blockId },
  });
}

function updateBlockOps(
  ops: Operation[],
  oldB: BlockRecord,
  newB: BlockRecord,
  spaceId: string,
  now: number,
): void {
  // Only send fields that actually changed. Sending properties when only
  // the format changed (or vice versa) would overwrite Notion-internal
  // decoration marks (inline comments, colors) that don't survive markdown.
  const args: Record<string, unknown> = { last_edited_time: now };

  if (oldB.type !== newB.type) {
    args.type = newB.type;
  }
  if (propertiesChanged(oldB, newB)) {
    args.properties = mergeCommentMarks(oldB.properties, newB.properties ?? {});
  }
  if (formatChanged(oldB, newB)) {
    args.format = newB.format ?? {};
  }

  ops.push({
    pointer: { table: "block", id: oldB.id, spaceId },
    path: [],
    command: "update",
    args,
  });
}

function createBlockOps(
  ops: Operation[],
  block: BlockRecord,
  parentId: string,
  spaceId: string,
  now: number,
): void {
  ops.push({
    pointer: { table: "block", id: block.id, spaceId },
    path: [],
    command: "set",
    args: {
      id: block.id,
      version: 1,
      type: block.type,
      properties: block.properties ?? {},
      format: block.format ?? {},
      content: block.children?.map((c) => c.id) ?? [],
      parent_id: parentId,
      parent_table: "block",
      alive: true,
      created_time: now,
      last_edited_time: now,
    },
  });

  if (block.children) {
    for (const child of block.children) {
      createBlockOps(ops, child, block.id, spaceId, now);
    }
  }
}

function diffChildrenOps(
  ops: Operation[],
  oldParent: BlockRecord,
  newParent: BlockRecord,
  spaceId: string,
  now: number,
): void {
  const oldChildren = oldParent.children ?? [];
  const newChildren = newParent.children ?? [];

  if (oldChildren.length === 0 && newChildren.length === 0) return;

  // If the old block had no children, just create all new ones
  if (oldChildren.length === 0) {
    for (const child of newChildren) {
      createBlockOps(ops, child, newParent.id, spaceId, now);
    }
    // Update parent's content list
    ops.push({
      pointer: { table: "block", id: newParent.id, spaceId },
      path: ["content"],
      command: "set",
      args: newChildren.map((c) => c.id),
    });
    return;
  }

  // If the new block has no children, delete all old ones
  if (newChildren.length === 0) {
    for (const child of oldChildren) {
      deleteBlockOps(ops, child.id, oldParent.id, spaceId);
    }
    return;
  }

  // Recursive diff on children
  const childMatch = matchBlocks(oldChildren, newChildren);

  for (const ci of childMatch.deletions) {
    deleteBlockOps(ops, oldChildren[ci].id, oldParent.id, spaceId);
  }

  for (const [oci, nci] of childMatch.matched) {
    const oldC = oldChildren[oci];
    const newC = newChildren[nci];
    newC.id = oldC.id;

    if (needsUpdate(oldC, newC)) {
      updateBlockOps(ops, oldC, newC, spaceId, now);
    }
    if (newC.children || oldC.children) {
      diffChildrenOps(ops, oldC, newC, spaceId, now);
    }
  }

  for (const nci of childMatch.insertions) {
    createBlockOps(ops, newChildren[nci], newParent.id, spaceId, now);
  }

  rebuildContentOrder(ops, newParent.id, spaceId, oldChildren, newChildren);
}

/**
 * Rebuild a block's content array to match the new order.
 * Only emits operations if the order actually changed.
 */
function rebuildContentOrder(
  ops: Operation[],
  parentId: string,
  spaceId: string,
  oldBlocks: BlockRecord[],
  newBlocks: BlockRecord[],
): void {
  const oldOrder = oldBlocks.map((b) => b.id);
  const newOrder = newBlocks.map((b) => b.id);

  if (JSON.stringify(oldOrder) === JSON.stringify(newOrder)) return;

  // Set the content list directly to the new order
  ops.push({
    pointer: { table: "block", id: parentId, spaceId },
    path: ["content"],
    command: "set",
    args: newOrder,
  });
}
