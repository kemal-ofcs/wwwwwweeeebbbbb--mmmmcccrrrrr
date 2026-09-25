import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  MEDIA_INSERT_SQL,
  MEDIA_MIME,
  validateMediaUpload,
} from "@/lib/validations/media";
import {
  SAMPLE_TERMINAL_STATUSES,
  type SampleStatus,
} from "@/lib/validations/sample";

/**
 * Foto tiket sampel (PRD FR-07) — jalur Web. Cermin
 * `desktop_upload_sample_media` dan `desktop_get_media` di `commands.rs`.
 * Kompresi terjadi di browser; server memeriksa ulang hasilnya.
 */

/** WAJIB sama isinya dengan `SAMPLE_MEDIA_LIST_SQL` di `commands.rs`. */
export const SAMPLE_MEDIA_LIST_SQL =
  "SELECT m.id, m.purpose, m.byte_size, m.created_by, o.nama_operator AS created_by_name, m.created_at, CASE WHEN m.data_base64 <> '' THEN 1 ELSE 0 END AS has_data FROM media_asset m LEFT JOIN master_operator o ON o.id = m.created_by WHERE m.owner_type = 'sample' AND m.owner_id = ? ORDER BY m.created_at, m.rowid;";

export interface SampleMediaRecord {
  id: string;
  purpose: string;
  byte_size: number;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  has_data: number;
}

export async function listSampleMedia(
  executor: Client | Transaction,
  sampleId: string,
): Promise<SampleMediaRecord[]> {
  const result = await executor.execute({
    sql: SAMPLE_MEDIA_LIST_SQL,
    args: [sampleId],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    purpose: String(row.purpose),
    byte_size: Number(row.byte_size),
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_by_name:
      row.created_by_name == null ? null : String(row.created_by_name),
    created_at: String(row.created_at),
    has_data: Number(row.has_data),
  }));
}

/** Cermin `check_media_allowed`; pesan identik. */
async function checkMediaAllowed(
  transaction: Transaction,
  sample: { id: string; status: string; is_paid_sample: number },
  purpose: string,
) {
  if (SAMPLE_TERMINAL_STATUSES.includes(sample.status as SampleStatus)) {
    throw new ApiRequestError("This sample request is closed.", 400);
  }
  if (purpose === "PAYMENT_PROOF" && sample.is_paid_sample !== 1) {
    throw new ApiRequestError("Payment proof is only for paid samples.", 400);
  }
  const limit = (await loadBusinessSettings(transaction)).max_photos_per_sample;
  const count = await transaction.execute({
    sql: "SELECT COUNT(*) AS total FROM media_asset WHERE owner_type = 'sample' AND owner_id = ?;",
    args: [sample.id],
  });
  if (Number(count.rows[0]?.total) >= limit) {
    throw new ApiRequestError(
      `This sample request already has the most photos allowed (${limit}).`,
      400,
    );
  }
}

export async function uploadSampleMedia(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const sampleId =
    typeof input.sample_id === "string" ? input.sample_id.trim() : "";
  const checked = validateMediaUpload(input.purpose, input.data_base64);
  if ("error" in checked) throw new ApiRequestError(checked.error, 400);
  const purpose = String(input.purpose);
  const data = String(input.data_base64);

  const transaction = await client.transaction("write");
  try {
    const found = await transaction.execute({
      sql: "SELECT s.id, s.status, s.is_paid_sample, s.brand_name, c.client_code FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?;",
      args: [sampleId],
    });
    const row = found.rows[0];
    if (!row) throw new ApiRequestError("Sample request not found.", 404);
    await checkMediaAllowed(
      transaction,
      {
        id: sampleId,
        status: String(row.status),
        is_paid_sample: Number(row.is_paid_sample),
      },
      purpose,
    );
    const id = crypto.randomUUID();
    const clock = await transaction.execute("SELECT datetime('now') AS stamp;");
    const now = String(clock.rows[0]?.stamp);
    await transaction.execute({
      sql: MEDIA_INSERT_SQL,
      args: [id, sampleId, purpose, checked.byte_size, data, actor.id, now],
    });
    await writeAudit(transaction, actor, "sample.photo", "sample", sampleId, {
      client_code: String(row.client_code ?? ""),
      brand_name: String(row.brand_name ?? ""),
      purpose,
      byte_size: checked.byte_size,
    });
    await transaction.commit();
    return { id, purpose, byte_size: checked.byte_size, created_at: now };
  } finally {
    transaction.close();
  }
}

export async function getMediaData(client: Client, id: unknown) {
  const key = typeof id === "string" ? id.trim() : "";
  const result = await client.execute({
    sql: "SELECT data_base64 FROM media_asset WHERE id = ? AND data_base64 <> '';",
    args: [key],
  });
  const data = result.rows[0]?.data_base64;
  if (data == null) throw new ApiRequestError("Photo not found.", 404);
  return { id: key, mime: MEDIA_MIME, data_base64: String(data) };
}
