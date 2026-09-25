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
import { listLeadInteractions } from "@/lib/server/leads";

export const runtime = "nodejs";

/** Cerminan `desktop_list_lead_interactions`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "leads.view");
    const body = await readJsonBody<{ lead_id?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      interactions: await listLeadInteractions(
        getServerDatabase(),
        body.lead_id,
      ),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
