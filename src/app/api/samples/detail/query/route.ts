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
import { getSampleRequest } from "@/lib/server/samples";

export const runtime = "nodejs";

/** Cerminan `desktop_get_sample_request`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "samples.view");
    const body = await readJsonBody<{ id?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      ...(await getSampleRequest(getServerDatabase(), body.id)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
