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
import { recordBatchStage } from "@/lib/server/production";

export const runtime = "nodejs";

/** Cerminan `desktop_record_batch_stage` (v3.2, PRD F-25). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "production.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const result = await recordBatchStage(getServerDatabase(), body, operator);
    // Packing selesai: grup CS dan Finance diberi tahu sesudah respons (US-22).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
