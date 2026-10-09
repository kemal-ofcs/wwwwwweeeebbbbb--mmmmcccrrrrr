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
import { recordMouStep } from "@/lib/server/mou";
import { dispatchNotificationsQuietly } from "@/lib/server/notifications";

export const runtime = "nodejs";

/** Cerminan `desktop_record_mou_step` (v2.5a, PRD F-20). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "mou.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const step = await recordMouStep(getServerDatabase(), body, operator);
    // MoU disetujui: grup Finance diberi tahu sesudah respons (FR-08).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...step });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
