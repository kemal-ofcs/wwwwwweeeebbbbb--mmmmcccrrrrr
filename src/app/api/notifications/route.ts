import type { NextRequest } from "next/server";
import { requireWebSession } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  markNotificationsSeen,
  notificationAccess,
} from "@/lib/server/notifications";

export const runtime = "nodejs";

/** Cerminan `desktop_mark_notifications_seen`: membuka lonceng = semua dibaca. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebSession(request);
    notificationAccess(actor);
    await markNotificationsSeen(getServerDatabase(), actor.id);
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
