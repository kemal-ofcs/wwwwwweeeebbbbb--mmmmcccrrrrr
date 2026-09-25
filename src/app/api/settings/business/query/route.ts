import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/** Cerminan `desktop_get_business_settings`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.view");
    return noStoreJson({
      sukses: true,
      settings: await loadBusinessSettings(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
