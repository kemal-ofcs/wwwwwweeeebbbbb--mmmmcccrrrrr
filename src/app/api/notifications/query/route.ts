import { after, type NextRequest } from "next/server";
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
  dispatchNotificationsQuietly,
  listNotifications,
  notificationAccess,
} from "@/lib/server/notifications";

export const runtime = "nodejs";

/**
 * Cerminan `desktop_list_notifications`. Lonceng memanggilnya tiap 60 detik,
 * jadi di Web inilah pemicu pengirim yang paling rutin (tanpa worker latar).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebSession(request);
    const allowed = notificationAccess(actor);
    const database = getServerDatabase();
    after(() => dispatchNotificationsQuietly(database));
    return noStoreJson({
      sukses: true,
      ...(await listNotifications(database, allowed, actor.id)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
