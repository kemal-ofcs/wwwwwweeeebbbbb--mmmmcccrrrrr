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
import { listProduction } from "@/lib/server/production";

export const runtime = "nodejs";

/** Cerminan `desktop_list_production` (v3.1, PRD F-23/F-24). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "production.view");
    const result = await listProduction(getServerDatabase());
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
