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
import { importSheet, sheetKind } from "@/lib/server/sheet-import";

export const runtime = "nodejs";

/**
 * Cerminan `desktop_import_sheet` (v2.7, PRD F-22). Izin per jenis sheet:
 * uang masuk `finance.manage`, formulasi `rnd.manage`, desain
 * `design.manage` (keputusan G).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    // 5000 baris bisa melewati batas bawaan 2 MB (lihat impor klien).
    const body = await readJsonBody<Record<string, unknown>>(
      request,
      4_194_304,
    );
    const operator = await requireWebPermission(
      request,
      sheetKind(body).permission,
    );
    return noStoreJson({
      sukses: true,
      ...(await importSheet(getServerDatabase(), body, operator)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
