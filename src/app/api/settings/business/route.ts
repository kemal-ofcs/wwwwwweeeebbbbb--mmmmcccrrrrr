import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { saveBusinessSettings } from "@/lib/server/business-settings";
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

export const runtime = "nodejs";

/** Cerminan `desktop_save_business_settings`. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "settings.manage");
    const body = await readJsonBody<{ settings?: unknown }>(request);
    const settings = await saveBusinessSettings(
      getServerDatabase(),
      (body.settings ?? {}) as Record<string, unknown>,
      operator,
    );
    return noStoreJson({ sukses: true, settings });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
