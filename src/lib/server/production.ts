import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { companyTimezone, getClientCodeSettings } from "@/lib/server/clients";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
} from "@/lib/validations/client";
import { MOU_LIST_SQL } from "@/lib/validations/mou";
import {
  NOTIFY_BATCH_CREATED_SQL,
  NOTIFY_BATCH_SCHEDULED_SQL,
  NOTIFY_PO_LATE_SQL,
} from "@/lib/validations/notification";
import {
  applyPoAction,
  BATCH_ACTIVE_SQL,
  BATCH_CHANGED_ELSEWHERE,
  BATCH_CREATE_ACTION,
  BATCH_INSERT_SQL,
  BATCH_LIST_SQL,
  BATCH_NEEDS_RESCHEDULE_SQL,
  BATCH_READY_SQL,
  BATCH_SCHEDULE_ACTION,
  BATCH_SCHEDULE_SQL,
  BATCH_WAITING_PO_SQL,
  batchRequestError,
  MATERIALS_READY_ACTION,
  MOU_WITHOUT_BATCH_WHERE,
  materialsReadyError,
  PO_DELAY_SQL,
  PO_INSERT_SQL,
  PO_LIST_SQL,
  PO_STATUS_SQL,
  poLogNotes,
  SUPPLIER_LIST_SQL,
  scheduleLogNotes,
  validateBatchSchedule,
  validatePoDelay,
  validatePurchaseOrder,
} from "@/lib/validations/production";
import { SAMPLE_STATUS_LOG_INSERT_SQL } from "@/lib/validations/sample";

/**
 * Work order produksi (v3.1, PRD F-23/F-24) — jalur Web. Cermin
 * `desktop_list_production`, `desktop_create_batch`,
 * `desktop_record_purchase_order`, `desktop_mark_materials_ready`, dan
 * `desktop_save_batch_schedule` di `commands.rs`. Aturannya bersama
 * (`production.ts` ↔ `production.rs`).
 */

type Executor = Client | Transaction;
type Draft = Record<string, unknown>;

function invalid(message: string): never {
  throw new ApiRequestError(message, 400);
}

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

async function rows(executor: Executor, sql: string, args: unknown[] = []) {
  const result = await executor.execute({
    sql,
    args: args as never,
  });
  return result.rows.map(plain);
}

async function clock(executor: Executor) {
  const result = await executor.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch, datetime('now') AS stamp;",
  );
  return {
    epoch: Number(result.rows[0]?.epoch),
    stamp: String(result.rows[0]?.stamp),
  };
}

async function findBatch(executor: Executor, batchId: string) {
  const [batch] = await rows(executor, `${BATCH_LIST_SQL} WHERE b.id = ?;`, [
    batchId,
  ]);
  if (!batch) throw new ApiRequestError("Work order not found.", 404);
  return batch;
}

async function log(
  transaction: Transaction,
  args: {
    id: string;
    sampleId: string;
    from: string;
    to: string;
    action: string;
    notes: string;
    actor: AuditActor;
    stamp: string;
  },
) {
  await transaction.execute({
    sql: SAMPLE_STATUS_LOG_INSERT_SQL,
    args: [
      args.id,
      args.sampleId,
      args.from,
      args.to,
      args.action,
      args.notes,
      "",
      args.actor.id,
      args.stamp,
    ],
  });
}

export async function listProduction(client: Client) {
  const ready = await rows(
    client,
    `${MOU_LIST_SQL}${MOU_WITHOUT_BATCH_WHERE} ORDER BY m.status_changed_at, m.id;`,
  );
  return {
    ready: ready.filter((row) => Number(row.dp_cleared) === 1),
    batches: await rows(
      client,
      `${BATCH_LIST_SQL} ORDER BY b.created_at DESC, b.id;`,
    ),
    purchase_orders: await rows(
      client,
      `${PO_LIST_SQL} ORDER BY p.created_at, p.rowid;`,
    ),
    suppliers: await rows(client, SUPPLIER_LIST_SQL),
  };
}

/** Work order dan PO satu tiket sampel, untuk detail tiket. */
export async function sampleProduction(client: Client, sampleId: string) {
  const [batch] = await rows(
    client,
    `${BATCH_LIST_SQL} WHERE b.sample_request_id = ? ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1;`,
    [sampleId],
  );
  return {
    batch: batch ?? null,
    purchase_orders: await rows(
      client,
      `${PO_LIST_SQL} WHERE p.batch_id IN (SELECT id FROM production_batches WHERE sample_request_id = ?) ORDER BY p.created_at, p.rowid;`,
      [sampleId],
    ),
    suppliers: await rows(client, SUPPLIER_LIST_SQL),
  };
}

export async function createBatch(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const mouId = id(input.mou_id);
  const transaction = await client.transaction("write");
  try {
    const [mou] = await rows(transaction, `${MOU_LIST_SQL} WHERE m.id = ?;`, [
      mouId,
    ]);
    if (!mou) throw new ApiRequestError("MoU not found.", 404);
    const [active] = await rows(transaction, BATCH_ACTIVE_SQL, [mouId, ""]);
    const blocked = batchRequestError(
      String(mou.status),
      Number(mou.dp_cleared) === 1,
      Number(active?.total ?? 0),
    );
    if (blocked) invalid(blocked);
    const { epoch, stamp } = await clock(transaction);
    const codes = await getClientCodeSettings(transaction);
    const tag = codes.client_code_web_tag;
    const dateStamp = companyDateStamp(
      epoch,
      await companyTimezone(transaction),
    );
    const existing = await rows(
      transaction,
      "SELECT batch_code FROM production_batches WHERE batch_code LIKE ?;",
      [`%-${dateStamp}-${tag}__`],
    );
    const sequence = nextClientSequence(
      existing.map((row) => String(row.batch_code)),
      dateStamp,
      tag,
    );
    const code =
      sequence == null
        ? null
        : formatClientCode(codes.batch_code_prefix, dateStamp, tag, sequence);
    if (!code) {
      throw new ApiRequestError(
        "The Web has used up its work order numbers for today.",
        409,
      );
    }
    const batchId = crypto.randomUUID();
    const sampleId = String(mou.sample_request_id);
    await transaction.execute({
      sql: BATCH_INSERT_SQL,
      args: [
        batchId,
        code,
        mouId,
        sampleId,
        String(mou.client_id),
        actor.id,
        stamp,
      ],
    });
    await log(transaction, {
      id: crypto.randomUUID(),
      sampleId,
      from: "",
      to: "UNCHECKED",
      action: BATCH_CREATE_ACTION,
      notes: `Work order ${code}`,
      actor,
      stamp,
    });
    await transaction.execute({
      sql: NOTIFY_BATCH_CREATED_SQL,
      args: [batchId],
    });
    await writeAudit(transaction, actor, "batch.create", "sample", sampleId, {
      client_code: String(mou.client_code ?? ""),
      brand_name: String(mou.brand_name ?? ""),
      mou_number: String(mou.mou_number ?? ""),
      batch_code: code,
    });
    await transaction.commit();
    return { id: batchId, batch_code: code };
  } finally {
    transaction.close();
  }
}

/** `step` = `{ action, po_id, order, delay }`. Cermin `desktop_record_purchase_order`. */
export async function recordPurchaseOrder(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const batchId = id(input.batch_id);
  const step =
    input.step && typeof input.step === "object" ? (input.step as Draft) : {};
  const action = typeof step.action === "string" ? step.action : "";
  const transaction = await client.transaction("write");
  try {
    const batch = await findBatch(transaction, batchId);
    let poId: string;
    let baseStatus = "";
    let baseEta = "";
    let number: string;
    let supplier: string;
    let order: ReturnType<typeof validatePurchaseOrder> | null = null;
    let delay: ReturnType<typeof validatePoDelay> | null = null;
    if (action === "PO_ADD") {
      order = validatePurchaseOrder(step.order);
      if ("error" in order) invalid(order.error);
      const [option] = await rows(
        transaction,
        "SELECT label, is_active FROM master_option WHERE id = ? AND kind = 'SUPPLIER';",
        [order.order.supplier_option_id],
      );
      if (!option || Number(option.is_active) !== 1) {
        invalid("Choose an active supplier.");
      }
      poId = crypto.randomUUID();
      baseEta = order.order.eta_on;
      number = order.order.po_number;
      supplier = String(option.label);
    } else {
      poId = id(step.po_id);
      const [po] = await rows(
        transaction,
        `${PO_LIST_SQL} WHERE p.id = ? AND p.batch_id = ?;`,
        [poId, batchId],
      );
      if (!po) throw new ApiRequestError("Purchase order not found.", 404);
      baseStatus = String(po.status);
      baseEta = String(po.eta_on);
      number = String(po.po_number);
      supplier = String(po.supplier_label ?? "");
      const allowed = applyPoAction(baseStatus, action);
      if ("error" in allowed) invalid(allowed.error);
      if (action === "PO_LATE") {
        delay = validatePoDelay(step.delay, baseEta);
        if ("error" in delay) invalid(delay.error);
      }
    }
    const next = applyPoAction(baseStatus, action);
    if ("error" in next) invalid(next.error);
    const late = delay && "delay" in delay ? delay.delay : null;
    const notes = poLogNotes(
      action,
      number,
      supplier,
      late ? late.eta_on : baseEta,
      late ? late.reason : "",
    );
    const { stamp } = await clock(transaction);
    let changed: number;
    if (order && "order" in order) {
      const o = order.order;
      changed = (
        await transaction.execute({
          sql: PO_INSERT_SQL,
          args: [
            poId,
            batchId,
            o.po_number,
            o.supplier_option_id,
            o.eta_on,
            actor.id,
            stamp,
          ],
        })
      ).rowsAffected;
    } else if (late) {
      changed = (
        await transaction.execute({
          sql: PO_DELAY_SQL,
          args: [poId, late.eta_on, late.reason, stamp, baseEta],
        })
      ).rowsAffected;
    } else {
      changed = (
        await transaction.execute({
          sql: PO_STATUS_SQL,
          args: [poId, next.status, stamp],
        })
      ).rowsAffected;
    }
    if (changed === 0) throw new ApiRequestError(BATCH_CHANGED_ELSEWHERE, 409);
    if (action === "PO_ADD" || action === "PO_LATE") {
      await transaction.execute({
        sql:
          action === "PO_ADD"
            ? BATCH_WAITING_PO_SQL
            : BATCH_NEEDS_RESCHEDULE_SQL,
        args: [batchId, stamp],
      });
    }
    const sampleId = String(batch.sample_request_id);
    const logId = crypto.randomUUID();
    await log(transaction, {
      id: logId,
      sampleId,
      from: baseStatus,
      to: next.status,
      action,
      notes,
      actor,
      stamp,
    });
    if (action === "PO_LATE") {
      await transaction.execute({
        sql: NOTIFY_PO_LATE_SQL,
        args: [logId, poId],
      });
    }
    await writeAudit(
      transaction,
      actor,
      "batch.purchase_order",
      "sample",
      sampleId,
      {
        client_code: String(batch.client_code ?? ""),
        brand_name: String(batch.brand_name ?? ""),
        batch_code: String(batch.batch_code),
        action,
        notes,
      },
    );
    await transaction.commit();
    return { id: poId, status: next.status };
  } finally {
    transaction.close();
  }
}

export async function markMaterialsReady(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const batchId = id(input.batch_id);
  const transaction = await client.transaction("write");
  try {
    const batch = await findBatch(transaction, batchId);
    const material = String(batch.material_status);
    const blocked = materialsReadyError(material, Number(batch.open_orders));
    if (blocked) invalid(blocked);
    const { stamp } = await clock(transaction);
    const changed = await transaction.execute({
      sql: BATCH_READY_SQL,
      args: [batchId, stamp],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(BATCH_CHANGED_ELSEWHERE, 409);
    }
    const sampleId = String(batch.sample_request_id);
    await log(transaction, {
      id: crypto.randomUUID(),
      sampleId,
      from: material,
      to: "READY",
      action: MATERIALS_READY_ACTION,
      notes: "Materials ready",
      actor,
      stamp,
    });
    await writeAudit(transaction, actor, "batch.ready", "sample", sampleId, {
      client_code: String(batch.client_code ?? ""),
      brand_name: String(batch.brand_name ?? ""),
      batch_code: String(batch.batch_code),
    });
    await transaction.commit();
    return { id: batchId, material_status: "READY" };
  } finally {
    transaction.close();
  }
}

export async function saveBatchSchedule(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const batchId = id(input.batch_id);
  const transaction = await client.transaction("write");
  try {
    const batch = await findBatch(transaction, batchId);
    const checked = validateBatchSchedule(
      input.schedule,
      String(batch.sched_packing_on ?? "") !== "",
    );
    if ("error" in checked) invalid(checked.error);
    const s = checked.schedule;
    const { stamp } = await clock(transaction);
    const changed = await transaction.execute({
      sql: BATCH_SCHEDULE_SQL,
      args: [
        batchId,
        s.weighing_on,
        s.mixing_on,
        s.filling_on,
        s.packing_on,
        stamp,
        String(batch.schedule_updated_at ?? ""),
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(BATCH_CHANGED_ELSEWHERE, 409);
    }
    const sampleId = String(batch.sample_request_id);
    const logId = crypto.randomUUID();
    await log(transaction, {
      id: logId,
      sampleId,
      from: "",
      to: "SCHEDULED",
      action: BATCH_SCHEDULE_ACTION,
      notes: scheduleLogNotes(s),
      actor,
      stamp,
    });
    await transaction.execute({
      sql: NOTIFY_BATCH_SCHEDULED_SQL,
      args: [logId, batchId],
    });
    await writeAudit(transaction, actor, "batch.schedule", "sample", sampleId, {
      client_code: String(batch.client_code ?? ""),
      brand_name: String(batch.brand_name ?? ""),
      batch_code: String(batch.batch_code),
      schedule: s,
    });
    await transaction.commit();
    return { id: batchId };
  } finally {
    transaction.close();
  }
}
