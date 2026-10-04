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
import { recordSampleStep } from "@/lib/server/samples";

export const runtime = "nodejs";

/** Cerminan `desktop_record_sample_step`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "samples.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const step = await recordSampleStep(getServerDatabase(), body, operator);
    // Antrean RnD/Finance diberi tahu sesudah respons (PRD FR-08).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...step });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
