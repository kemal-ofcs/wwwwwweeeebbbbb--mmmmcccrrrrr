import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { listMasterOptions } from "@/lib/server/clients";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/**
 * Cerminan `desktop_list_master_options`. Cukup `clients.view`: form intake
 * butuh daftar pilihannya walau pengguna tidak mengelola Master Data.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "clients.view");
    return noStoreJson({
      sukses: true,
      options: await listMasterOptions(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
