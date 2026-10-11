import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  CLIENT_HANDOVER_SQL,
  CRM_ASSIGN_SQL,
  CRM_CLIENT_LIST_SQL,
  CRM_NOT_HANDED_OVER,
  CRM_OPERATOR_INVALID,
  CRM_OWNER_SQL,
  crmOwnerError,
  FORMULA_REPEAT_COPY_SQL,
  PRICE_REPEAT_COPY_SQL,
  REPEAT_ORDER_ACTION,
  REPEAT_ORDER_NOTES,
  REPEAT_SOURCE_SQL,
  repeatOrderError,
  SAMPLE_REPEAT_INSERT_SQL,
  validateCrmForward,
} from "@/lib/validations/crm";
import {
  NOTIFY_CRM_FORWARD_SQL,
  NOTIFY_HANDOVER_SQL,
} from "@/lib/validations/notification";
import { SAMPLE_STATUS_LOG_INSERT_SQL } from "@/lib/validations/sample";

/**
 * Serah terima CS -> CRM dan antrean CRM (v3.6a, PRD F-29, D-49) — jalur Web.
 * Cermin `desktop_list_crm`, `desktop_assign_crm`, `desktop_forward_to_crm`,
 * dan `crm_owner_gate` di `commands.rs`.
 */

type Executor = Client | Transaction;
/** Route meneruskan `OperatorUser`; tes boleh memakai pelaku tanpa izin. */
type Actor = AuditActor &
  Partial<Pick<OperatorUser, "permissions" | "isSuperadmin">>;

function plain(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

function id(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canCrm(actor: Actor) {
  return (
    actor.isSuperadmin === true ||
    (actor.permissions ?? []).includes("crm.manage")
  );
}

/**
 * Gerbang CS (keputusan D1). `clientOrLeadId` = id klien atau id lead.
 * Mengembalikan `true` bila klien dikelola CRM dan pelaku memegang
 * `crm.manage`.
 */
export async function assertCrmOwner(
  executor: Executor,
  clientOrLeadId: string,
  actor: Actor,
) {
  const result = await executor.execute({
    sql: CRM_OWNER_SQL,
    args: [clientOrLeadId],
  });
  const row = result.rows[0];
  if (!row) return false;
  const blocked = crmOwnerError(
    String(row.lifecycle_status),
    canCrm(actor),
    String(row.crm_name ?? ""),
  );
  if (blocked) throw new AuthorizationError(blocked, 403);
  return String(row.lifecycle_status) === "EXISTING_CLIENT";
}

/** Order selesai: serah terima ke CRM + notifikasi sekali (keputusan B). */
export async function handOverToCrm(
  transaction: Transaction,
  clientId: string,
  stamp: string,
) {
  if (!clientId) return;
  await transaction.execute({
    sql: CLIENT_HANDOVER_SQL,
    args: [clientId, stamp],
  });
  await transaction.execute({ sql: NOTIFY_HANDOVER_SQL, args: [clientId] });
}

const CRM_OPERATORS_SQL =
  "SELECT m.id, m.nama_operator FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE r.role_key = 'crm' AND COALESCE(m.status, 'Active') = 'Active' ORDER BY m.nama_operator;";

export async function listCrm(client: Client) {
  const clients = await client.execute(
    `${CRM_CLIENT_LIST_SQL} ORDER BY reorder_on, client_code;`,
  );
  const operators = await client.execute(CRM_OPERATORS_SQL);
  return {
    clients: clients.rows.map(plain),
    operators: operators.rows.map(plain),
  };
}

async function stampOf(executor: Executor) {
  const result = await executor.execute("SELECT datetime('now') AS stamp;");
  return String(result.rows[0]?.stamp);
}

/** Ambil atau pindahkan PIC CRM (keputusan C). */
export async function assignCrm(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const clientId = id(input.client_id);
  const operatorId = input.operator_id;
  const transaction = await client.transaction("write");
  try {
    const crm =
      typeof operatorId === "number" && Number.isSafeInteger(operatorId)
        ? await transaction.execute({
            sql: "SELECT m.nama_operator FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE m.id = ? AND r.role_key = 'crm' AND COALESCE(m.status, 'Active') = 'Active';",
            args: [operatorId],
          })
        : null;
    const name = crm?.rows[0]?.nama_operator;
    if (name == null) throw new ApiRequestError(CRM_OPERATOR_INVALID, 400);
    const stamp = await stampOf(transaction);
    const changed = await transaction.execute({
      sql: CRM_ASSIGN_SQL,
      args: [clientId, operatorId as number, stamp],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(CRM_NOT_HANDED_OVER, 409);
    }
    const code = await transaction.execute({
      sql: "SELECT client_code FROM clients WHERE id = ?;",
      args: [clientId],
    });
    await writeAudit(
      transaction,
      actor,
      "client.assign_crm",
      "client",
      clientId,
      {
        client_code: String(code.rows[0]?.client_code ?? ""),
        crm_name: String(name),
      },
    );
    await transaction.commit();
    return { id: clientId };
  } finally {
    transaction.close();
  }
}

/** CS meneruskan klien CRM ke grup CRM (E-33, keputusan E). */
export async function forwardToCrm(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const clientId = id(input.client_id);
  const checked = validateCrmForward(input.forward);
  if ("error" in checked) throw new ApiRequestError(checked.error, 400);
  const transaction = await client.transaction("write");
  try {
    const current = await transaction.execute({
      sql: "SELECT client_code, lifecycle_status FROM clients WHERE id = ?;",
      args: [clientId],
    });
    const row = current.rows[0];
    if (!row) throw new ApiRequestError("Client not found.", 404);
    if (String(row.lifecycle_status) !== "EXISTING_CLIENT") {
      throw new ApiRequestError(CRM_NOT_HANDED_OVER, 409);
    }
    const forwardId = crypto.randomUUID();
    const stamp = await stampOf(transaction);
    await transaction.execute({
      sql: NOTIFY_CRM_FORWARD_SQL,
      args: [forwardId, clientId, checked.notes, actor.id, stamp],
    });
    await writeAudit(
      transaction,
      actor,
      "client.forward_crm",
      "client",
      clientId,
      { client_code: String(row.client_code), notes: checked.notes },
    );
    await transaction.commit();
    return { id: forwardId };
  } finally {
    transaction.close();
  }
}

/**
 * Repeat order (v3.6b, D-50): tiket baru langsung `CLIENT_ACC` dari tiket
 * yang ordernya selesai, beserta formula dan harga terakhirnya. Cermin
 * `desktop_repeat_sample_order`.
 */
export async function repeatSampleOrder(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const sourceId = id(input.source_id);
  const transaction = await client.transaction("write");
  try {
    const found = await transaction.execute({
      sql: REPEAT_SOURCE_SQL,
      args: [sourceId],
    });
    const source = found.rows[0];
    if (!source) throw new ApiRequestError("Sample request not found.", 404);
    const blocked = repeatOrderError(
      String(source.status),
      Number(source.completed) === 1,
    );
    if (blocked) throw new ApiRequestError(blocked, 409);
    const newId = crypto.randomUUID();
    const stamp = await stampOf(transaction);
    await transaction.execute({
      sql: SAMPLE_REPEAT_INSERT_SQL,
      args: [newId, sourceId, actor.id, stamp],
    });
    for (const sql of [FORMULA_REPEAT_COPY_SQL, PRICE_REPEAT_COPY_SQL]) {
      await transaction.execute({ sql, args: [newId, sourceId, stamp] });
    }
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        crypto.randomUUID(),
        newId,
        "",
        "CLIENT_ACC",
        REPEAT_ORDER_ACTION,
        REPEAT_ORDER_NOTES,
        "",
        actor.id,
        stamp,
      ],
    });
    await writeAudit(transaction, actor, "sample.repeat", "sample", newId, {
      client_code: String(source.client_code ?? ""),
      brand_name: String(source.brand_name ?? ""),
      source_id: sourceId,
    });
    await transaction.commit();
    return { id: newId };
  } finally {
    transaction.close();
  }
}
