import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  LEGAL_CHANGED_ELSEWHERE,
  LEGAL_EXISTING_SQL,
  LEGAL_UPSERT_SQL,
  legalGateError,
  legalLogNotes,
  validateLegalRecord,
} from "@/lib/validations/legal";
import { MEDIA_INSERT_SQL, validateMediaUpload } from "@/lib/validations/media";
import { MOU_LIST_SQL } from "@/lib/validations/mou";
import { SAMPLE_STATUS_LOG_INSERT_SQL } from "@/lib/validations/sample";

/**
 * Dokumen legal (v2.6, PRD F-21) — jalur Web. Cermin
 * `desktop_record_legal_document`; aturannya bersama (`legal.ts` ↔ `legal.rs`).
 */

function invalid(message: string): never {
  throw new ApiRequestError(message, 400);
}

/** Status per jenis; baris ganda dari dua perangkat: yang tertua menang. */
async function legalStatuses(transaction: Transaction, mouId: string) {
  const result = await transaction.execute({
    sql: "SELECT kind, status FROM legal_documents WHERE mou_id = ? ORDER BY created_at DESC, rowid DESC;",
    args: [mouId],
  });
  const statuses: Record<string, string> = {};
  for (const row of result.rows)
    statuses[String(row.kind)] = String(row.status);
  return statuses;
}

export async function recordLegalDocument(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const mouId = typeof input.mou_id === "string" ? input.mou_id.trim() : "";
  const checked = validateLegalRecord(input.document);
  if ("error" in checked) invalid(checked.error);
  const record = checked.record;
  let evidence: { data: string; size: number } | null = null;
  if (typeof input.evidence_base64 === "string" && input.evidence_base64) {
    const media = validateMediaUpload("LEGAL_DOCUMENT", input.evidence_base64);
    if ("error" in media) invalid(media.error);
    evidence = { data: input.evidence_base64, size: media.byte_size };
  }
  const transaction = await client.transaction("write");
  try {
    const found = await transaction.execute({
      sql: `${MOU_LIST_SQL} WHERE m.id = ?;`,
      args: [mouId],
    });
    const mou = found.rows[0];
    if (!mou) throw new ApiRequestError("MoU not found.", 404);
    const blocked = legalGateError(
      {
        mou_status: String(mou.status),
        regulatory_path: String(mou.regulatory_path),
        dp_cleared: Number(mou.dp_cleared) === 1,
        statuses: await legalStatuses(transaction, mouId),
      },
      record.kind,
    );
    if (blocked) invalid(blocked);
    const existing = (
      await transaction.execute({
        sql: LEGAL_EXISTING_SQL,
        args: [mouId, record.kind],
      })
    ).rows[0];
    const id = existing ? String(existing.id) : crypto.randomUUID();
    const baseUpdatedAt = existing ? String(existing.updated_at) : "";
    const baseStatus = existing ? String(existing.status) : "";
    const sampleId = String(mou.sample_request_id);
    const clock = await transaction.execute("SELECT datetime('now') AS stamp;");
    const now = String(clock.rows[0]?.stamp);
    const changed = await transaction.execute({
      sql: LEGAL_UPSERT_SQL,
      args: [
        id,
        mouId,
        sampleId,
        record.kind,
        record.status,
        record.reference_no,
        record.certificate_no,
        record.bpom_type,
        record.submitted_on,
        record.issued_on,
        record.expires_on,
        record.notes,
        actor.id,
        now,
        baseUpdatedAt,
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(LEGAL_CHANGED_ELSEWHERE, 409);
    }
    if (evidence) {
      await transaction.execute({
        sql: MEDIA_INSERT_SQL,
        args: [
          crypto.randomUUID(),
          sampleId,
          "LEGAL_DOCUMENT",
          evidence.size,
          evidence.data,
          actor.id,
          now,
        ],
      });
    }
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        crypto.randomUUID(),
        sampleId,
        baseStatus,
        record.status,
        `LEGAL_${record.kind}`,
        legalLogNotes(record),
        "",
        actor.id,
        now,
      ],
    });
    await writeAudit(transaction, actor, "legal.record", "sample", sampleId, {
      client_code: String(mou.client_code ?? ""),
      brand_name: String(mou.brand_name ?? ""),
      mou_number: String(mou.mou_number ?? ""),
      record,
    });
    await transaction.commit();
    return { id, status: record.status };
  } finally {
    transaction.close();
  }
}
