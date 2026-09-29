import { NotionAPI } from "notion-client";
import type { ExtendedRecordMap } from "notion-types";
import type { SyncConfig } from "../types.js";

export class StaleTokenError extends Error {
  constructor(public readonly cause?: string) {
    super(
      cause
        ? `Notion token_v2 is expired or invalid (or lacks access to this page): ${cause}`
        : "Notion token_v2 is expired or invalid",
    );
    this.name = "StaleTokenError";
  }
}

export class CloudflareBlockError extends Error {
  constructor() {
    super(
      "The request to notion.so was blocked by Cloudflare's bot protection, not rejected by " +
        "Notion itself. This is unrelated to your token_v2/notion_user_id — re-entering " +
        "credentials will not help. Wait a while before retrying, and avoid firing requests in " +
        "quick succession; if it persists, try from a different network (e.g. without a VPN/proxy).",
    );
    this.name = "CloudflareBlockError";
  }
}

function isCloudflareChallenge(body: unknown): boolean {
  return (
    typeof body === "string" &&
    body.includes("Cloudflare") &&
    (body.includes("Attention Required") || body.includes("Sorry, you have been blocked"))
  );
}

// Notion's Cloudflare front rejects unofficial /api/v3 requests with no (or
// Node's default) User-Agent header. notion-client 7.x doesn't set one itself.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function createReadClient(config: SyncConfig): NotionAPI {
  return new NotionAPI({
    authToken: config.tokenV2,
    activeUser: config.userId,
    ofetchOptions: { headers: { "User-Agent": BROWSER_USER_AGENT } },
  });
}

export async function fetchPage(
  client: NotionAPI,
  pageId: string,
): Promise<ExtendedRecordMap> {
  try {
    return await client.getPage(pageId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | undefined)?.status;
    const data = (err as { data?: unknown } | undefined)?.data;
    if (isCloudflareChallenge(data) || isCloudflareChallenge(msg)) {
      throw new CloudflareBlockError();
    }
    if (
      status === 401 ||
      status === 403 ||
      msg.includes("401") ||
      msg.includes("403") ||
      msg.includes("Unauthorized") ||
      msg.includes("unauthorized") ||
      msg.includes("Forbidden") ||
      msg.includes("forbidden")
    ) {
      const detail = data ? `${msg} — response body: ${JSON.stringify(data)}` : msg;
      throw new StaleTokenError(detail);
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
      "User-Agent": BROWSER_USER_AGENT,
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

  if (!res.ok) {
    const body = await res.text();
    if (isCloudflareChallenge(body)) {
      throw new CloudflareBlockError();
    }
    if (res.status === 401 || res.status === 403) {
      throw new StaleTokenError(`${res.status}: ${body}`);
    }
    throw new Error(`Notion API saveTransactionsFanout failed (${res.status}): ${body}`);
  }
}
