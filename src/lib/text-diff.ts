import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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

/**
 * Show a diff by shelling out to an external tool (e.g. meld, vimdiff,
 * `code --diff`) instead of the built-in unified diff. Writes local/remote
 * (and, when available, base) content to temp files and substitutes
 * $LOCAL/$REMOTE/$BASE in the command. $BASE is only written and substituted
 * when `base` is given (i.e. a shadow file exists), so a two-way tool that
 * only references $LOCAL/$REMOTE keeps working unchanged; a three-way-capable
 * tool (meld, vimdiff -d, Beyond Compare) can use $BASE to distinguish local
 * edits from remote edits since the last sync.
 *
 * Unlike invokeExternalTool for merges, the exit code is ignored: many diff
 * tools (e.g. `diff`, `git diff --no-index`) exit non-zero simply to signal
 * that differences were found, not that the tool failed. Returns false only
 * if the command itself couldn't be launched.
 */
export function invokeExternalDiffTool(
  command: string,
  local: string,
  remote: string,
  base?: string,
): boolean {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-diff-"));
  const localPath = path.join(tmpDir, "LOCAL.md");
  const remotePath = path.join(tmpDir, "REMOTE.md");
  const basePath = path.join(tmpDir, "BASE.md");

  try {
    fs.writeFileSync(localPath, local, "utf-8");
    fs.writeFileSync(remotePath, remote, "utf-8");

    let cmd = command
      .replace(/\$LOCAL/g, localPath)
      .replace(/\$REMOTE/g, remotePath);

    if (base !== undefined) {
      fs.writeFileSync(basePath, base, "utf-8");
      cmd = cmd.replace(/\$BASE/g, basePath);
    }

    const result = spawnSync(cmd, { shell: true, stdio: "inherit" });
    return result.error === undefined;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
