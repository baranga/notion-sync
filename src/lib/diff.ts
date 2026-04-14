import type { BlockRecord } from "./blocks.js";

export interface MatchResult {
  /** Pairs of [oldIndex, newIndex] for matched blocks */
  matched: [number, number][];
  /** Indices into oldBlocks that have no match (to be deleted) */
  deletions: number[];
  /** Indices into newBlocks that have no match (to be created) */
  insertions: number[];
}

/**
 * Extract plain text from a block's title decorations.
 * Works on both Notion API blocks and markdown-derived BlockRecords.
 */
function blockText(block: BlockRecord): string {
  const title = block.properties?.title;
  if (!Array.isArray(title)) return "";
  return (title as unknown[][])
    .map((d) => (d.length > 0 ? String(d[0]) : ""))
    .join("");
}

/**
 * Coarse fingerprint for LCS matching: type + plain text content.
 * Ignores formatting, colors, and other Notion-specific metadata so that
 * blocks from the Notion API and blocks from markdownToBlocks can match.
 */
export function blockFingerprint(block: BlockRecord): string {
  return `${block.type}:${blockText(block)}`;
}

/**
 * Decoration format tags that exist in Notion but have no markdown
 * representation. These must be stripped before comparing old (Notion)
 * values against new (markdown-derived) values, otherwise every block
 * with a comment or color would appear "changed" on every push —
 * and the resulting update would overwrite the decoration marks,
 * destroying inline comment references.
 */
const NON_MARKDOWN_FORMATS = new Set(["m", "h", "u", "p"]);

/**
 * Normalize a Decoration[]-shaped value for comparison by:
 * 1. Stripping Notion-only format marks (comments, colors, mentions)
 * 2. Merging adjacent entries whose formatting is now identical
 *
 * Step 2 is critical: Notion splits text around comment/color boundaries,
 * e.g. `[["Hello",[["m","disc"]]],[" world"]]`. After stripping the `["m"]`
 * mark we get `[["Hello"],[" world"]]`, which looks different from the
 * markdown-derived `[["Hello world"]]` even though the content is identical.
 * Merging adjacent same-format entries normalises both to `[["Hello world"]]`.
 */
function normalizeDecorations(val: unknown): unknown {
  if (!Array.isArray(val) || val.length === 0) return val;
  // A Decoration[] is an array of tuples: [string] | [string, SubDecoration[]]
  if (!Array.isArray(val[0]) || typeof val[0][0] !== "string") return val;

  // Phase 1: strip non-markdown format tags
  const stripped = (val as unknown[][]).map((dec) => {
    if (dec.length <= 1) return dec;
    const formats = dec[1];
    if (!Array.isArray(formats)) return dec;
    const kept = (formats as unknown[][]).filter(
      (fmt) => !Array.isArray(fmt) || !NON_MARKDOWN_FORMATS.has(fmt[0] as string),
    );
    return kept.length > 0 ? [dec[0], kept] : [dec[0]];
  });

  // Phase 2: merge adjacent entries with identical formatting
  const merged: unknown[][] = [];
  for (const dec of stripped) {
    const text = String(dec[0]);
    if (text === "") continue;

    const fmts = dec.length > 1 ? dec[1] : undefined;
    const fmtKey = fmts ? JSON.stringify(fmts) : "";

    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevFmtKey = prev.length > 1 ? JSON.stringify(prev[1]) : "";

      if (fmtKey === prevFmtKey) {
        merged[merged.length - 1] = fmts
          ? [String(prev[0]) + text, fmts]
          : [String(prev[0]) + text];
        continue;
      }
    }

    merged.push(fmts ? [text, fmts] : [text]);
  }

  return merged;
}

/**
 * Check whether a matched block needs a property/format update.
 * Strips Notion-only decoration marks (comments, colors, mentions) from
 * old values before comparing so that we don't emit spurious updates that
 * would overwrite inline comment markers.
 */
export function needsUpdate(oldB: BlockRecord, newB: BlockRecord): boolean {
  return (
    oldB.type !== newB.type ||
    propertiesChanged(oldB, newB) ||
    formatChanged(oldB, newB)
  );
}

/** True when markdown-visible properties differ. */
export function propertiesChanged(
  oldB: BlockRecord,
  newB: BlockRecord,
): boolean {
  if (!newB.properties) return false;
  for (const [key, val] of Object.entries(newB.properties)) {
    const oldNorm = normalizeDecorations(oldB.properties?.[key]);
    const newNorm = normalizeDecorations(val);
    if (JSON.stringify(oldNorm) !== JSON.stringify(newNorm)) return true;
  }
  return false;
}

/** True when markdown-visible format fields differ. */
export function formatChanged(oldB: BlockRecord, newB: BlockRecord): boolean {
  if (!newB.format) return false;
  for (const [key, val] of Object.entries(newB.format)) {
    if (JSON.stringify(oldB.format?.[key]) !== JSON.stringify(val)) return true;
  }
  return false;
}

// --- Comment mark transplanting -----------------------------------------------

interface CommentMark {
  text: string;
  discussionId: string;
  /** Character offset in the flattened old text */
  start: number;
}

/**
 * Walk a Decoration[] and extract every `["m", id]`-marked text span
 * together with its character offset in the concatenated plain text.
 */
function extractCommentMarks(decs: unknown[][]): CommentMark[] {
  const marks: CommentMark[] = [];
  let offset = 0;
  for (const dec of decs) {
    const text = String(dec[0]);
    const fmts = dec.length > 1 && Array.isArray(dec[1]) ? (dec[1] as unknown[][]) : [];
    for (const fmt of fmts) {
      if (Array.isArray(fmt) && fmt[0] === "m") {
        marks.push({ text, discussionId: fmt[1] as string, start: offset });
      }
    }
    offset += text.length;
  }
  return marks;
}

/**
 * Split a Decoration[] at a character range, injecting an extra format mark
 * on the slice at [start, start+length). Returns a new Decoration[].
 */
function injectMark(
  decs: unknown[][],
  start: number,
  length: number,
  mark: unknown[],
): unknown[][] {
  const result: unknown[][] = [];
  let offset = 0;

  for (const dec of decs) {
    const text = String(dec[0]);
    const fmts: unknown[][] =
      dec.length > 1 && Array.isArray(dec[1]) ? (dec[1] as unknown[][]) : [];
    const end = offset + text.length;
    const mStart = start - offset;
    const mEnd = mStart + length;

    if (mStart >= text.length || mEnd <= 0 || end <= start || offset >= start + length) {
      // No overlap — keep entry as-is
      result.push(dec);
    } else {
      // Three potential slices: before, inside, after
      const sliceBefore = text.slice(0, Math.max(0, mStart));
      const sliceInside = text.slice(Math.max(0, mStart), Math.min(text.length, mEnd));
      const sliceAfter = text.slice(Math.min(text.length, mEnd));

      if (sliceBefore) {
        result.push(fmts.length > 0 ? [sliceBefore, fmts] : [sliceBefore]);
      }
      if (sliceInside) {
        const merged = [...fmts, mark];
        result.push([sliceInside, merged]);
      }
      if (sliceAfter) {
        result.push(fmts.length > 0 ? [sliceAfter, fmts] : [sliceAfter]);
      }
    }
    offset = end;
  }
  return result;
}

/**
 * Given old and new Decoration[] for a block title, transplant `["m", id]`
 * comment marks from the old into the new wherever the commented text can
 * be located in the new plain text (exact substring match, first occurrence
 * from the original position).
 *
 * Returns the new Decoration[] with marks re-attached — or the original
 * newTitle unchanged if there are no marks to transplant.
 */
export function transplantCommentMarks(
  oldTitle: unknown[][],
  newTitle: unknown[][],
): unknown[][] {
  const marks = extractCommentMarks(oldTitle);
  if (marks.length === 0) return newTitle;

  const newPlain = newTitle.map((d) => String(d[0])).join("");
  let result = newTitle;

  for (const { text, discussionId, start } of marks) {
    // Search for the commented text near its original position
    // Try exact position first, then scan outward
    let found = -1;
    const idx = newPlain.indexOf(text, Math.max(0, start - text.length));
    if (idx !== -1) {
      found = idx;
    } else {
      // Try from the beginning as fallback
      const fallback = newPlain.indexOf(text);
      if (fallback !== -1) found = fallback;
    }

    if (found !== -1) {
      result = injectMark(result, found, text.length, ["m", discussionId]);
    }
    // If text not found, the commented content was deleted — drop the mark
  }

  return result;
}

/**
 * For a block whose properties are about to be updated, merge comment marks
 * from the old properties into the new ones. Only affects Decoration[] values
 * (typically `title`). Returns a new properties object.
 */
export function mergeCommentMarks(
  oldProps: Record<string, unknown> | undefined,
  newProps: Record<string, unknown>,
): Record<string, unknown> {
  if (!oldProps) return newProps;

  const merged = { ...newProps };
  for (const key of Object.keys(merged)) {
    const oldVal = oldProps[key];
    const newVal = merged[key];
    // Only process Decoration[]-shaped values
    if (
      Array.isArray(oldVal) && oldVal.length > 0 && Array.isArray(oldVal[0]) &&
      Array.isArray(newVal) && newVal.length > 0 && Array.isArray(newVal[0])
    ) {
      merged[key] = transplantCommentMarks(
        oldVal as unknown[][],
        newVal as unknown[][],
      );
    }
  }
  return merged;
}

/**
 * Standard LCS on two string arrays.
 * Returns pairs of indices [idxA, idxB] that form the longest common subsequence.
 */
function lcs(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to find pairs
  const pairs: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

/**
 * Match old blocks to new blocks using a two-phase approach:
 *
 * Phase 1: Exact content match via LCS on fingerprints (type + text).
 * Phase 2: For remaining unmatched blocks, greedily match by same type
 *          in nearby positions (handles edited blocks).
 */
export function matchBlocks(
  oldBlocks: BlockRecord[],
  newBlocks: BlockRecord[],
): MatchResult {
  const oldFP = oldBlocks.map(blockFingerprint);
  const newFP = newBlocks.map(blockFingerprint);

  // Phase 1: exact matches via LCS
  const exactPairs = lcs(oldFP, newFP);
  const matched: [number, number][] = [...exactPairs];

  const matchedOld = new Set(exactPairs.map(([o]) => o));
  const matchedNew = new Set(exactPairs.map(([, n]) => n));

  // Phase 2: secondary matching — same type, closest position
  const unmatchedOld = oldBlocks
    .map((_, i) => i)
    .filter((i) => !matchedOld.has(i));
  const unmatchedNew = newBlocks
    .map((_, i) => i)
    .filter((i) => !matchedNew.has(i));

  const claimedNew = new Set<number>();

  for (const oi of unmatchedOld) {
    let bestIdx = -1;
    let bestDist = Infinity;

    for (const ni of unmatchedNew) {
      if (claimedNew.has(ni)) continue;
      if (oldBlocks[oi].type !== newBlocks[ni].type) continue;

      const dist = Math.abs(oi - ni);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = ni;
      }
    }

    if (bestIdx !== -1) {
      matched.push([oi, bestIdx]);
      matchedOld.add(oi);
      matchedNew.add(bestIdx);
      claimedNew.add(bestIdx);
    }
  }

  return {
    matched,
    deletions: oldBlocks.map((_, i) => i).filter((i) => !matchedOld.has(i)),
    insertions: newBlocks.map((_, i) => i).filter((i) => !matchedNew.has(i)),
  };
}
