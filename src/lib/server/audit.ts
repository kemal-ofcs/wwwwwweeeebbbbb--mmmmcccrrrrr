import "server-only";

import type { Client, Transaction } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { companyDayBoundsUtc } from "@/lib/validations/client";

/**
 * Log audit domain — jalur Web (PRD F-10).
 *
 * Perangkat menulis baris yang sama di SQLite lokal lalu mendorongnya lewat
 * rute `audit/record`; Web menulisnya langsung di transaksi mutasinya. Tabelnya
 * hanya-tambah: tidak ada fungsi di sini yang mengubah atau menghapus baris.
 */

/** WAJIB identik dengan `clients::DOMAIN_AUDIT_INSERT_SQL` di `clients.rs`. */
export const DOMAIN_AUDIT_INSERT_SQL =
  "INSERT INTO domain_audit_log (id, actor_operator_id, on_behalf_of_division, action, entity_type, entity_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/** WAJIB identik dengan `clients::DOMAIN_AUDIT_LIST_SQL` di `clients.rs`. */
export const DOMAIN_AUDIT_LIST_SQL =
  "SELECT a.id, a.actor_operator_id, o.nama_operator AS actor_name, a.on_behalf_of_division, a.action, a.entity_type, a.entity_id, a.summary_json, a.occurred_at FROM domain_audit_log a LEFT JOIN master_operator o ON o.id = a.actor_operator_id WHERE (?1 = '' OR a.entity_type = ?1) AND (?2 = 0 OR a.actor_operator_id = ?2) AND (?3 = '' OR a.occurred_at >= ?3) AND (?4 = '' OR a.occurred_at < ?4) ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 200;";

/** Pelaku audit: id operator dan role-nya saat aksi terjadi (kolom "atas nama divisi"). */
export type AuditActor = Pick<OperatorUser, "id" | "role">;

export interface AuditEntryRecord {
  id: string;
  actor_operator_id: number | null;
  actor_name: string | null;
  on_behalf_of_division: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary_json: string;
  occurred_at: string;
}

/** Tulis satu baris audit di transaksi mutasinya (PRD FR-10.1). */
export async function writeAudit(
  transaction: Transaction,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string,
  summary: Record<string, unknown>,
) {
  // Waktu dari database, bentuk sama dengan `clients::utc_timestamp`.
  const clock = await transaction.execute("SELECT datetime('now') AS stamp;");
  await transaction.execute({
    sql: DOMAIN_AUDIT_INSERT_SQL,
    args: [
      crypto.randomUUID(),
      actor.id,
      actor.role,
      action,
      entityType,
      entityId,
      JSON.stringify(summary),
      String(clock.rows[0]?.stamp),
    ],
  });
}

export async function listDomainAudit(
  client: Client,
  filter: Record<string, unknown>,
): Promise<AuditEntryRecord[]> {
  const text = (key: string) => {
    const value = filter[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const actor =
    typeof filter.actor_operator_id === "number" &&
    Number.isSafeInteger(filter.actor_operator_id)
      ? filter.actor_operator_id
      : 0;
  // Sama dengan `company_timezone` di `commands.rs`.
  const zone = await client.execute(
    "SELECT timezone FROM company_profile WHERE id = 'default_company';",
  );
  const timezone =
    String(zone.rows[0]?.timezone ?? "").trim() || "Asia/Jakarta";
  const from = companyDayBoundsUtc(text("from"), timezone)?.[0] ?? "";
  const to = companyDayBoundsUtc(text("to"), timezone)?.[1] ?? "";
  const result = await client.execute({
    sql: DOMAIN_AUDIT_LIST_SQL,
    args: [text("entity_type"), actor, from, to],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    actor_operator_id:
      row.actor_operator_id == null ? null : Number(row.actor_operator_id),
    actor_name: row.actor_name == null ? null : String(row.actor_name),
    on_behalf_of_division: String(row.on_behalf_of_division ?? ""),
    action: String(row.action),
    entity_type: String(row.entity_type),
    entity_id: String(row.entity_id),
    summary_json: String(row.summary_json ?? "{}"),
    occurred_at: String(row.occurred_at),
  }));
}
