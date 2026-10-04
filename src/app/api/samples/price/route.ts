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
import { recordSamplePrice } from "@/lib/server/samples";

export const runtime = "nodejs";

/** Cerminan `desktop_record_sample_price` (v2.2, PRD F-16). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "finance.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const saved = await recordSamplePrice(getServerDatabase(), body, operator);
    // Grup CS diberi tahu sesudah respons (PRD FR-08).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
