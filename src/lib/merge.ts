import { merge, mergeDiff3 } from "node-diff3";

export interface MergeResult {
  content: string;
  hasConflicts: boolean;
  /** Number of conflicting sections (conflict marker blocks) in `content`. */
  conflicts: number;
}

export interface MergeLabels {
  local: string;
  base: string;
  remote: string;
}

export interface MergeOptions {
  /** Text after the conflict markers (single line each). */
  labels?: MergeLabels;
  /**
   * diff3-style markers: include the base version in a `|||||||` section, so
   * it's clear what each side changed. Pointless without a real base.
   */
  showBase?: boolean;
}

const DEFAULT_LABELS: MergeLabels = { local: "LOCAL", base: "BASE", remote: "REMOTE" };

export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
  options: MergeOptions = {},
): MergeResult {
  const labels = options.labels ?? DEFAULT_LABELS;
  const run = options.showBase ? mergeDiff3 : merge;
  const result = run(
    local.split("\n"),
    base.split("\n"),
    remote.split("\n"),
    { label: { a: labels.local, o: labels.base, b: labels.remote } } as Parameters<typeof mergeDiff3>[3],
  );
  const startMarker = `<<<<<<< ${labels.local}`;
  return {
    content: result.result.join("\n"),
    hasConflicts: result.conflict,
    conflicts: result.result.filter((line) => line === startMarker).length,
  };
}

/** Whether text still contains (start or end) conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7})( |$)/m.test(text);
}
