import { after, type NextRequest } from "next/server";
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
import { dispatchNotificationsQuietly } from "@/lib/server/notifications";
import { saveBatchSchedule } from "@/lib/server/production";

export const runtime = "nodejs";

/** Cerminan `desktop_save_batch_schedule` (v3.1, PRD F-23/F-24). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "production.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const result = await saveBatchSchedule(getServerDatabase(), body, operator);
    // Jadwal disimpan: grup CS diberi tahu sesudah respons (FR-08).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
