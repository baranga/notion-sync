import { diffIndices } from "node-diff3";

export interface DiffResult {
  hasChanges: boolean;
  text: string;
}

const CONTEXT = 3;

/**
 * Git-style unified diff of two texts, built from node-diff3's LCS-based
 * diffIndices (already a project dependency, so no extra diff library needed).
 * Adjacent mismatched chunks within 2*CONTEXT lines of each other are merged
 * into a single hunk, mirroring `diff -U`/`git diff` output.
 */
export function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  fromText: string,
  toText: string,
): DiffResult {
  const fromLines = fromText.split("\n");
  const toLines = toText.split("\n");
  const chunks = diffIndices(fromLines, toLines);

  if (chunks.length === 0) {
    return { hasChanges: false, text: "" };
  }

  const hunks: string[] = [];
  let i = 0;
  while (i < chunks.length) {
    let end = i;
    while (
      end + 1 < chunks.length &&
      chunks[end + 1].buffer1[0] -
        (chunks[end].buffer1[0] + chunks[end].buffer1[1]) <=
        CONTEXT * 2
    ) {
      end++;
    }

    const first = chunks[i];
    const last = chunks[end];
    const fromStart = Math.max(0, first.buffer1[0] - CONTEXT);
    const fromEnd = Math.min(
      fromLines.length,
      last.buffer1[0] + last.buffer1[1] + CONTEXT,
    );
    const toStart = Math.max(0, first.buffer2[0] - CONTEXT);
    const toEnd = Math.min(
      toLines.length,
      last.buffer2[0] + last.buffer2[1] + CONTEXT,
    );

    const body: string[] = [];
    let cursor = fromStart;
    for (let c = i; c <= end; c++) {
      const chunk = chunks[c];
      while (cursor < chunk.buffer1[0]) {
        body.push(` ${fromLines[cursor]}`);
        cursor++;
      }
      for (const line of chunk.buffer1Content) body.push(`-${line}`);
      for (const line of chunk.buffer2Content) body.push(`+${line}`);
      cursor = chunk.buffer1[0] + chunk.buffer1[1];
    }
    while (cursor < fromEnd) {
      body.push(` ${fromLines[cursor]}`);
      cursor++;
    }

    hunks.push(
      `@@ -${fromStart + 1},${fromEnd - fromStart} +${toStart + 1},${toEnd - toStart} @@`,
      ...body,
    );

    i = end + 1;
  }

  return {
    hasChanges: true,
    text: [`--- ${fromLabel}`, `+++ ${toLabel}`, ...hunks].join("\n"),
  };
}
