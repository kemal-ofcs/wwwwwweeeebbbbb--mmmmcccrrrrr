import "server-only";

import type { Client } from "@libsql/client";
import {
  ACTIVE_SESSION_LIST_SQL,
  SESSION_END_OPERATOR_SQL,
  SESSION_END_SQL,
  SESSION_ENDED_BY_ADMIN,
} from "@/lib/auth/session-sql";
import { hashSessionToken } from "@/lib/auth/session-token";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";

/**
 * Sesi aktif dan pengakhirannya — jalur Web (PRD FR-10.3, FR-10.4).
 *
 * Cermin `desktop_list_active_sessions`, `desktop_end_session`, dan
 * `desktop_end_operator_sessions` di `commands.rs`. Pesan penolakan identik.
 */

export interface ActiveSessionRecord {
  session_id: string;
  operator_id: number;
  operator_name: string | null;
  client_kind: string;
  device_label: string;
  created_at: string;
  last_seen_at: string;
}

/** Cermin `clients::session_end_reason`. */
export function sessionEndReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim() : "";
  const length = [...reason].length;
  if (length < 3 || length > 300) {
    throw new ApiRequestError(
      "Give a reason of 3-300 characters for ending the session.",
      400,
    );
  }
  return reason;
}

export async function listActiveSessions(
  client: Client,
): Promise<ActiveSessionRecord[]> {
  const result = await client.execute(ACTIVE_SESSION_LIST_SQL);
  return result.rows.map((row) => ({
    session_id: String(row.session_id),
    operator_id: Number(row.operator_id),
    operator_name: row.operator_name == null ? null : String(row.operator_name),
    client_kind: String(row.client_kind ?? "web"),
    device_label: String(row.device_label ?? ""),
    created_at: String(row.created_at),
    last_seen_at: String(row.last_seen_at),
  }));
}

/** Id sesi milik cookie ini, supaya layar bisa menandai "sesi ini". */
export async function currentSessionId(client: Client, token: string) {
  if (!token) return null;
  const result = await client.execute({
    sql: "SELECT session_id FROM app_session WHERE token_hash = ? LIMIT 1;",
    args: [await hashSessionToken(token)],
  });
  const id = result.rows[0]?.session_id;
  return id == null ? null : String(id);
}

/**
 * Akhiri satu sesi (`session_id`) atau semua sesi seorang operator
 * (`operator_id`). Baris audit ditulis di transaksi yang sama. Perangkat
 * targetnya keluar dalam satu siklus sync; sesi Web di permintaan berikutnya.
 */
export async function endSessions(
  client: Client,
  target: { session_id?: unknown; operator_id?: unknown; reason?: unknown },
  actor: AuditActor,
) {
  const reason = sessionEndReason(target.reason);
  const sessionId =
    typeof target.session_id === "string" ? target.session_id.trim() : "";
  const operatorId =
    typeof target.operator_id === "number" &&
    Number.isSafeInteger(target.operator_id)
      ? target.operator_id
      : 0;
  if ((sessionId === "") === (operatorId === 0)) {
    throw new ApiRequestError("Choose one session or one operator.", 400);
  }

  const transaction = await client.transaction("write");
  try {
    let owner = operatorId;
    let ended = 0;
    if (sessionId) {
      const found = await transaction.execute({
        sql: "SELECT operator_id FROM app_session WHERE session_id = ? AND revoked_at IS NULL;",
        args: [sessionId],
      });
      const row = found.rows[0];
      if (!row)
        throw new ApiRequestError("That session has already ended.", 404);
      owner = Number(row.operator_id);
      const result = await transaction.execute({
        sql: SESSION_END_SQL,
        args: [sessionId, SESSION_ENDED_BY_ADMIN],
      });
      ended = result.rowsAffected;
    } else {
      const result = await transaction.execute({
        sql: SESSION_END_OPERATOR_SQL,
        args: [operatorId, SESSION_ENDED_BY_ADMIN],
      });
      ended = result.rowsAffected;
    }
    await writeAudit(
      transaction,
      actor,
      sessionId ? "session.end" : "session.end_all",
      "session",
      sessionId || `operator:${operatorId}`,
      { operator_id: owner, reason, sessions: ended },
    );
    await transaction.commit();
    return { count: ended };
  } finally {
    transaction.close();
  }
}
