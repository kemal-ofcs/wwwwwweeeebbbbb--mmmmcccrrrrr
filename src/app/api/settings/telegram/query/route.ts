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
import { getTelegramSettings } from "@/lib/server/notifications";

export const runtime = "nodejs";

/** Cerminan `desktop_get_telegram_config`. Token tidak pernah ikut dikembalikan. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.manage");
    return noStoreJson({
      sukses: true,
      ...(await getTelegramSettings(getServerDatabase())),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
