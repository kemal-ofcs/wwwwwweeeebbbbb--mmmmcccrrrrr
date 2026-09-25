import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { recordLeadInteraction } from "@/lib/server/leads";

export const runtime = "nodejs";

/** Cerminan `desktop_record_lead_interaction`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "leads.manage");
    const body = await readJsonBody<{ interaction?: unknown }>(request);
    const saved = await recordLeadInteraction(
      getServerDatabase(),
      (body.interaction ?? {}) as Record<string, unknown>,
      operator,
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
