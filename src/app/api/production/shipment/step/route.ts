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
import { recordShipmentStep } from "@/lib/server/production";
import { shipmentActionPermission } from "@/lib/validations/production";

export const runtime = "nodejs";

/** Cerminan `desktop_record_shipment_step` (v3.4, PRD F-27). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    const step =
      body.step && typeof body.step === "object"
        ? (body.step as Record<string, unknown>)
        : {};
    // Forwarded milik CS, langkah lain Logistik (keputusan D).
    const operator = await requireWebPermission(
      request,
      shipmentActionPermission(step.action),
    );
    const result = await recordShipmentStep(
      getServerDatabase(),
      body,
      operator,
    );
    // Barang keluar: grup CS diberi tahu sesudah respons (keputusan H).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
