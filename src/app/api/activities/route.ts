import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import { recordActivity } from "@/lib/server/example-domain";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/** Cerminan `desktop_record_activity`; operatornya diambil dari sesi, bukan body. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "activity.record");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const eventKey = await recordActivity(
      getServerDatabase(),
      body ?? {},
      actor.kode_operator,
    );
    return noStoreJson({ sukses: true, event_key: eventKey });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
