import type { NextRequest } from "next/server";
import { createApprovalLink } from "@/lib/server/approval";
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
import { approvalPermission } from "@/lib/validations/approval";

export const runtime = "nodejs";

/** Cerminan `desktop_create_approval_link` (v2.5b, PRD F-18). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    // Izin membuat tautan sama dengan izin mencatat jawabannya manual.
    const operator = await requireWebPermission(
      request,
      approvalPermission(body.entity_type),
    );
    return noStoreJson({
      sukses: true,
      ...(await createApprovalLink(getServerDatabase(), body, operator)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
