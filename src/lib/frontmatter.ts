import matter from "gray-matter";
import type { FileFrontmatter } from "../types.js";

export function parseFrontmatter(raw: string): {
  data: FileFrontmatter;
  content: string;
} {
  const { data, content } = matter(raw);
  return { data: data as FileFrontmatter, content };
}

export function stringifyFrontmatter(
  data: FileFrontmatter,
  content: string,
): string {
  return matter.stringify(content, data);
}
