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
import { reassignLead } from "@/lib/server/leads";

export const runtime = "nodejs";

/** Cerminan `desktop_reassign_lead`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "leads.reassign");
    const body = await readJsonBody<{ lead_id?: unknown; pic_cs_id?: unknown }>(
      request,
    );
    await reassignLead(getServerDatabase(), body.lead_id, body.pic_cs_id);
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
