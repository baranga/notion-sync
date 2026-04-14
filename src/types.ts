export interface SyncConfig {
  tokenV2: string;
  source: "env" | "home" | "local";
  mergeTool?: string;
}

export interface FileFrontmatter {
  notion_url?: string;
  notion_id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface SyncOptions {
  dryRun: boolean;
  verbose: boolean;
  force?: boolean;
}
