import fs from "node:fs";
import path from "node:path";

const SHADOW_DIR = path.join(process.cwd(), ".notion-sync", "shadow");

export function shadowPath(filePath: string): string {
  const rel = path.relative(process.cwd(), path.resolve(filePath));
  return path.join(SHADOW_DIR, rel);
}

export function readShadow(filePath: string): string | null {
  const p = shadowPath(filePath);
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function writeShadow(filePath: string, content: string): void {
  const p = shadowPath(filePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}
