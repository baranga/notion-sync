import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { merge } from "node-diff3";

export interface MergeResult {
  content: string;
  hasConflicts: boolean;
}

export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
): MergeResult {
  const result = merge(
    local.split("\n"),
    base.split("\n"),
    remote.split("\n"),
    { label: { a: "LOCAL", o: "BASE", b: "REMOTE" } } as Parameters<typeof merge>[3],
  );
  return {
    content: result.result.join("\n"),
    hasConflicts: result.conflict,
  };
}

export function invokeExternalTool(
  command: string,
  base: string,
  local: string,
  remote: string,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-merge-"));
  const basePath = path.join(tmpDir, "BASE.md");
  const localPath = path.join(tmpDir, "LOCAL.md");
  const remotePath = path.join(tmpDir, "REMOTE.md");
  const mergedPath = path.join(tmpDir, "MERGED.md");

  try {
    fs.writeFileSync(basePath, base, "utf-8");
    fs.writeFileSync(localPath, local, "utf-8");
    fs.writeFileSync(remotePath, remote, "utf-8");
    fs.writeFileSync(mergedPath, local, "utf-8");

    const cmd = command
      .replace(/\$BASE/g, basePath)
      .replace(/\$LOCAL/g, localPath)
      .replace(/\$REMOTE/g, remotePath)
      .replace(/\$MERGED/g, mergedPath);

    execSync(cmd, { stdio: "inherit" });

    return fs.readFileSync(mergedPath, "utf-8");
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
