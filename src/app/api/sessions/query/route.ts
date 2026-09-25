import type { NextRequest } from "next/server";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
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
import { currentSessionId, listActiveSessions } from "@/lib/server/sessions";

export const runtime = "nodejs";

/** Cerminan `desktop_list_active_sessions`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "sessions.manage");
    const client = getServerDatabase();
    return noStoreJson({
      sukses: true,
      current_session_id: await currentSessionId(
        client,
        request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "",
      ),
      sessions: await listActiveSessions(client),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
