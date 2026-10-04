import type { NextRequest } from "next/server";
import { hasPermission } from "@/lib/auth/access";
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
    const operator = await requireWebPermission(request, "samples.view");
    const body = await readJsonBody<{ id?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      // Rincian HPP dan margin hanya untuk `pricing.view` (v2.2).
      ...(await getSampleRequest(
        getServerDatabase(),
        body.id,
        hasPermission(operator, "pricing.view"),
      )),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
