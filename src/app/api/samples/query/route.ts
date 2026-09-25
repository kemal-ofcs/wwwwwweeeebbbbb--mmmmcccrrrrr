import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { listSampleRequests } from "@/lib/server/samples";

export const runtime = "nodejs";

/** Cerminan `desktop_list_sample_requests`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "samples.view");
    return noStoreJson({
      sukses: true,
      ...(await listSampleRequests(getServerDatabase())),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
