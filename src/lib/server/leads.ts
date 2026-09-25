import "server-only";

import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  INTERACTION_NOTES_MAX,
  isLeadInteractionDirection,
  isLeadInteractionKind,
  resolveInteractionTime,
  utcTimestamp,
} from "@/lib/validations/client";

/**
 * Interaksi lead dan pemindahan PIC — jalur Web (PRD F-05).
 *
 * Cermin `desktop_list_lead_interactions`, `desktop_record_lead_interaction`,
 * `desktop_list_operator_directory`, dan `desktop_reassign_lead` di
 * `commands.rs`. Pesan penolakan identik dengan Rust.
 */

/**
 * WAJIB identik dengan `clients::LEAD_SUMMARY_UPDATE_SQL` di `clients.rs`:
 * tanggal hanya maju, dan Jumlah FU bertambah hanya bila interaksi itu belum
 * pernah tercatat — aman diulang dan tidak bergantung urutan.
 * Parameter: ?1 arah, ?2 waktu interaksi, ?3 id lead, ?4 id interaksi.
 */
export const LEAD_SUMMARY_UPDATE_SQL =
  "UPDATE leads SET last_followup_at = CASE WHEN ?1 = 'OUTBOUND' AND ?2 > last_followup_at THEN ?2 ELSE last_followup_at END, last_client_response_at = CASE WHEN ?1 = 'INBOUND' AND ?2 > last_client_response_at THEN ?2 ELSE last_client_response_at END, total_followups = total_followups + CASE WHEN ?1 = 'OUTBOUND' THEN 1 ELSE 0 END WHERE id = ?3 AND NOT EXISTS (SELECT 1 FROM lead_interactions WHERE id = ?4);";

/** WAJIB identik dengan `clients::LEAD_INTERACTION_INSERT_SQL`. */
export const LEAD_INTERACTION_INSERT_SQL =
  "INSERT INTO lead_interactions (id, lead_id, operator_id, direction, kind, notes, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export interface LeadInteractionRecord {
  id: string;
  lead_id: string;
  operator_id: number | null;
  operator_name: string | null;
  direction: string;
  kind: string;
  notes: string;
  occurred_at: string;
  created_at: string;
}

export interface OperatorDirectoryEntry {
  id: number;
  kode_operator: string;
  nama_operator: string;
}

type Draft = Record<string, unknown>;

function leadInvalid(message: string): never {
  throw new ApiRequestError(message, 400);
}

function text(source: Draft, key: string) {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function operatorCan(operator: OperatorUser, permission: string) {
  return (
    operator.isSuperadmin ||
    (operator.permissions as readonly string[]).includes(permission)
  );
}

export async function listLeadInteractions(
  client: Client,
  leadId: unknown,
): Promise<LeadInteractionRecord[]> {
  const result = await client.execute({
    sql: `SELECT i.id, i.lead_id, i.operator_id, o.nama_operator, i.direction, i.kind,
                 i.notes, i.occurred_at, i.created_at
          FROM lead_interactions i LEFT JOIN master_operator o ON o.id = i.operator_id
          WHERE i.lead_id = ? ORDER BY i.occurred_at DESC, i.created_at DESC, i.rowid DESC;`,
    args: [typeof leadId === "string" ? leadId.trim() : ""],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    lead_id: String(row.lead_id),
    operator_id: row.operator_id == null ? null : Number(row.operator_id),
    operator_name: row.nama_operator == null ? null : String(row.nama_operator),
    direction: String(row.direction),
    kind: String(row.kind),
    notes: String(row.notes),
    occurred_at: String(row.occurred_at),
    created_at: String(row.created_at),
  }));
}

/**
 * Catat satu follow up atau respons klien. Hanya di lead milik sendiri,
 * kecuali pemegang `leads.reassign` (PRD OQ-34). Ringkasan lead dan baris
 * interaksi ditulis dalam satu transaksi.
 */
export async function recordLeadInteraction(
  client: Client,
  interaction: Draft,
  operator: OperatorUser,
) {
  const leadId = text(interaction, "lead_id");
  const direction = text(interaction, "direction");
  if (!isLeadInteractionDirection(direction)) {
    leadInvalid("Choose whether this is a follow up or a client response.");
  }
  const kind = text(interaction, "kind");
  if (!isLeadInteractionKind(kind)) {
    leadInvalid("Choose how the contact happened.");
  }
  const notes = text(interaction, "notes");
  if (!notes || [...notes].length > INTERACTION_NOTES_MAX) {
    leadInvalid("Notes are required, up to 1000 characters.");
  }

  const transaction = await client.transaction("write");
  try {
    const clock = await transaction.execute(
      "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch;",
    );
    const now = Number(clock.rows[0]?.epoch);
    const occurred = resolveInteractionTime(interaction.occurred_at, now);
    if ("error" in occurred) leadInvalid(occurred.error);

    const lead = await transaction.execute({
      sql: "SELECT l.pic_cs_id, c.client_code FROM leads l JOIN clients c ON c.id = l.client_id WHERE l.id = ?;",
      args: [leadId],
    });
    const row = lead.rows[0];
    if (!row) throw new ApiRequestError("Lead not found.", 404);
    const pic = row.pic_cs_id == null ? null : Number(row.pic_cs_id);
    if (pic !== operator.id && !operatorCan(operator, "leads.reassign")) {
      throw new AuthorizationError(
        "Only the lead's CS can record on it. Ask an Admin to reassign the lead.",
        403,
      );
    }

    const id = crypto.randomUUID();
    const occurredAt = utcTimestamp(occurred.epoch);
    await transaction.execute({
      sql: LEAD_SUMMARY_UPDATE_SQL,
      args: [direction, occurredAt, leadId, id],
    });
    await transaction.execute({
      sql: LEAD_INTERACTION_INSERT_SQL,
      args: [
        id,
        leadId,
        operator.id,
        direction,
        kind,
        notes,
        occurredAt,
        utcTimestamp(now),
      ],
    });
    await writeAudit(
      transaction,
      operator,
      "lead_interaction.record",
      "lead",
      leadId,
      {
        client_code: String(row.client_code),
        interaction_id: id,
        direction,
        kind,
      },
    );
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

export async function listOperatorDirectory(
  client: Client,
): Promise<OperatorDirectoryEntry[]> {
  const result = await client.execute(
    `SELECT id, kode_operator, nama_operator FROM master_operator
     WHERE COALESCE(status, 'Active') = 'Active' ORDER BY nama_operator, id;`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    kode_operator: String(row.kode_operator),
    nama_operator: String(row.nama_operator),
  }));
}

/** Pindahkan lead ke PIC CS lain (PRD OQ-34). */
export async function reassignLead(
  client: Client,
  leadId: unknown,
  picCsId: unknown,
  actor: AuditActor,
) {
  const id = typeof leadId === "string" ? leadId.trim() : "";
  const pic =
    typeof picCsId === "number" && Number.isSafeInteger(picCsId) ? picCsId : 0;
  const transaction = await client.transaction("write");
  try {
    const lead = await transaction.execute({
      sql: "SELECT c.client_code FROM leads l JOIN clients c ON c.id = l.client_id WHERE l.id = ?;",
      args: [id],
    });
    if (!lead.rows[0]) throw new ApiRequestError("Lead not found.", 404);
    const active = await transaction.execute({
      sql: "SELECT 1 AS found FROM master_operator WHERE id = ? AND COALESCE(status, 'Active') = 'Active';",
      args: [pic],
    });
    if (!active.rows[0]) leadInvalid("Choose an active operator.");
    await transaction.execute({
      sql: "UPDATE leads SET pic_cs_id = ?, updated_at = datetime('now') WHERE id = ?;",
      args: [pic, id],
    });
    await writeAudit(transaction, actor, "lead.reassign", "lead", id, {
      client_code: String(lead.rows[0].client_code),
      pic_cs_id: pic,
    });
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
