import type { NextRequest } from "next/server";
import { hasPermission } from "@/lib/auth/access";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { importClients } from "@/lib/server/client-import";
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

export const runtime = "nodejs";

/**
 * Cerminan `desktop_import_clients`. `dry_run: true` = pratinjau. Impor
 * menetapkan PIC untuk operator lain, jadi menuntut `clients.manage` DAN
 * `leads.reassign` (PRD FR-09, keputusan H).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "clients.manage");
    if (!hasPermission(operator, "leads.reassign")) {
      throw new AuthorizationError("Access denied for this action.", 403);
    }
    // 5000 baris bisa melewati batas bawaan 2 MB; 4 MB masih di bawah batas
    // body Vercel (4,5 MB).
    const body = await readJsonBody<Record<string, unknown>>(
      request,
      4_194_304,
    );
    return noStoreJson({
      sukses: true,
      ...(await importClients(getServerDatabase(), body, operator)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
