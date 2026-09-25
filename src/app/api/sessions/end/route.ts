import type { NextRequest } from "next/server";
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
import { endSessions } from "@/lib/server/sessions";

export const runtime = "nodejs";

/** Cerminan `desktop_end_session` dan `desktop_end_operator_sessions`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "sessions.manage");
    const body = await readJsonBody<{
      session_id?: unknown;
      operator_id?: unknown;
      reason?: unknown;
    }>(request);
    const result = await endSessions(getServerDatabase(), body, operator);
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
