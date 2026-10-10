import type { NextRequest } from "next/server";
import { writeAudit } from "@/lib/server/audit";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

const SUBJECTS = ["clients", "samples", "invoices", "funds"];

/**
 * Ekspor CSV di Web (v2.8, PRD D-41): berkasnya dibuat browser dari daftar
 * yang sudah dimuat, jadi di sinilah izin `data.export` ditegakkan dan
 * ekspornya dicatat, sebelum unduhan. Cerminan `record_csv_export`.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "data.export");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const subject = typeof body.subject === "string" ? body.subject : "";
    if (!SUBJECTS.includes(subject)) {
      throw new ApiRequestError("Choose what to export.", 400);
    }
    const fileName = [
      ...(typeof body.file_name === "string" ? body.file_name : ""),
    ]
      .slice(0, 120)
      .join("");
    const rows = Number.isSafeInteger(body.rows) ? Number(body.rows) : 0;
    const transaction = await getServerDatabase().transaction("write");
    try {
      await writeAudit(
        transaction,
        operator,
        "data.export",
        "export",
        subject,
        {
          subject,
          file_name: fileName,
          rows,
        },
      );
      await transaction.commit();
    } finally {
      transaction.close();
    }
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
