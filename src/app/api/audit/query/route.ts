import type { NextRequest } from "next/server";
import { listDomainAudit } from "@/lib/server/audit";
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

export const runtime = "nodejs";

/** Cerminan `desktop_list_audit_log`. Web selalu membaca dari cloud. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "audit.view");
    const body = await readJsonBody<{ filter?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      source: "cloud",
      entries: await listDomainAudit(
        getServerDatabase(),
        (body.filter ?? {}) as Record<string, unknown>,
      ),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
