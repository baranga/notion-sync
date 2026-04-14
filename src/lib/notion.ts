import { NotionAPI } from "notion-client";
import type { ExtendedRecordMap } from "notion-types";
import type { SyncConfig } from "../types.js";

export class StaleTokenError extends Error {
  constructor() {
    super("Notion token_v2 is expired or invalid");
    this.name = "StaleTokenError";
  }
}

export function createReadClient(config: SyncConfig): NotionAPI {
  return new NotionAPI({ authToken: config.tokenV2 });
}

export async function fetchPage(
  client: NotionAPI,
  pageId: string,
): Promise<ExtendedRecordMap> {
  try {
    return await client.getPage(pageId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("unauthorized")) {
      throw new StaleTokenError();
    }
    throw err;
  }
}

// --- Write client for the unofficial API ---

const NOTION_API_BASE = "https://www.notion.so/api/v3";

export interface Operation {
  pointer: { table: string; id: string; spaceId: string };
  path: string[];
  command: string;
  args: unknown;
}

export async function submitTransaction(
  tokenV2: string,
  spaceId: string,
  operations: Operation[],
): Promise<void> {
  const res = await fetch(`${NOTION_API_BASE}/saveTransactionsFanout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `token_v2=${tokenV2}`,
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      transactions: [
        {
          id: crypto.randomUUID(),
          spaceId,
          operations,
        },
      ],
    }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new StaleTokenError();
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API saveTransactionsFanout failed (${res.status}): ${body}`);
  }
}
