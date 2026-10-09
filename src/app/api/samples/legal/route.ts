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
import { recordLegalDocument } from "@/lib/server/legal";
import { legalKindPermission } from "@/lib/validations/legal";

export const runtime = "nodejs";

/** Cerminan `desktop_record_legal_document` (v2.6, PRD F-21). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    const kind =
      body.document && typeof body.document === "object"
        ? (body.document as Record<string, unknown>).kind
        : undefined;
    // SIG dicatat RnD, dokumen lain Legal (keputusan G).
    const operator = await requireWebPermission(
      request,
      legalKindPermission(kind),
    );
    return noStoreJson({
      sukses: true,
      ...(await recordLegalDocument(getServerDatabase(), body, operator)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
