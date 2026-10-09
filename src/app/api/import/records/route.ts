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
import { listImportedRecords } from "@/lib/server/sheet-import";

export const runtime = "nodejs";

/** Cerminan `desktop_list_imported_records` (v2.7). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "clients.view");
    const body = await readJsonBody<{ client_id?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      records: await listImportedRecords(getServerDatabase(), body.client_id),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
