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
import { createShipment } from "@/lib/server/production";

export const runtime = "nodejs";

/** Cerminan `desktop_create_shipment` (v3.4, PRD F-27). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    const operator = await requireWebPermission(request, "shipping.manage");
    const result = await createShipment(getServerDatabase(), body, operator);
    // Barang keluar: grup CS diberi tahu sesudah respons (keputusan H).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
