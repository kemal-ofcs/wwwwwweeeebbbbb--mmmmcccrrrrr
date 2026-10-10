import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { companyTimezone, getClientCodeSettings } from "@/lib/server/clients";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
} from "@/lib/validations/client";
import { MEDIA_INSERT_SQL, validateMediaUpload } from "@/lib/validations/media";
import { MOU_LIST_SQL } from "@/lib/validations/mou";
import {
  NOTIFY_BATCH_CREATED_SQL,
  NOTIFY_BATCH_PACKED_SQL,
  NOTIFY_BATCH_SCHEDULED_SQL,
  NOTIFY_PO_LATE_SQL,
  NOTIFY_SHIPPED_SQL,
} from "@/lib/validations/notification";
import {
  applyPoAction,
  applyShipmentAction,
  BATCH_ACTIVE_SQL,
  BATCH_CHANGED_ELSEWHERE,
  BATCH_CREATE_ACTION,
  BATCH_INSERT_SQL,
  BATCH_LIST_SQL,
  BATCH_NEEDS_RESCHEDULE_SQL,
  BATCH_READY_SQL,
  BATCH_SCHEDULE_ACTION,
  BATCH_SCHEDULE_SQL,
  BATCH_STAGE_SQL,
  BATCH_WAITING_PO_SQL,
  batchRequestError,
  CARRIER_LIST_SQL,
  MATERIALS_READY_ACTION,
  MOU_WITHOUT_BATCH_WHERE,
  materialsReadyError,
  normalizeTracking,
  PO_DELAY_SQL,
  PO_INSERT_SQL,
  PO_LIST_SQL,
  PO_STATUS_SQL,
  PRODUCTION_REASON_MAX,
  PRODUCTION_STAGES,
  PRODUCTION_STARTED,
  type ProductionStage,
  poLogNotes,
  SHIPMENT_ACTIONS,
  SHIPMENT_ACTIVE_SQL,
  SHIPMENT_CANCEL_REASON_INVALID,
  SHIPMENT_CHANGED_ELSEWHERE,
  SHIPMENT_CREATE_ACTION,
  SHIPMENT_INSERT_SQL,
  SHIPMENT_LIST_SQL,
  SHIPMENT_STEP_SQL,
  SHIPMENT_UPDATE_SQL,
  type ShipmentInput,
  STAGE_LOG_SQL,
  SUPPLIER_LIST_SQL,
  scheduleLockError,
  scheduleLogNotes,
  shipGateError,
  shipmentLogNotes,
  shipmentRequestError,
  shipStateFromRow,
  shipSummary,
  stageGateError,
  stageLogNotes,
  TRACKING_INVALID,
  validateBatchSchedule,
  validatePoDelay,
  validatePurchaseOrder,
  validateShipment,
  validateStageRecord,
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
    stage_log: await rows(client, STAGE_LOG_SQL),
    // Pengiriman (v3.4) dan teks SOP Penyimpanan untuk PDF-nya.
    shipments: await rows(
      client,
      `${SHIPMENT_LIST_SQL} ORDER BY h.created_at, h.id;`,
    ),
    storage_sop_text: (await loadBusinessSettings(client)).storage_sop_text,
    carriers: await rows(client, CARRIER_LIST_SQL),
  };
}

/**
 * Tempelkan ringkasan kirim work order terbaru ke setiap baris tiket sampel
 * (v3.3): `ship_block`, `settlement_default_idr`, `storage_fee_idr`,
 * `settlement_cleared`; null bila tiket belum punya work order. Cermin
 * `attach_ship_state`.
 */
export async function attachShipState<T extends Record<string, unknown>>(
  executor: Executor,
  tickets: T[],
) {
  const batches = await rows(
    executor,
    `${BATCH_LIST_SQL} ORDER BY b.created_at, b.id;`,
  );
  const latest = new Map(
    batches.map((batch) => [String(batch.sample_request_id), batch]),
  );
  return tickets.map((ticket) => {
    const batch = latest.get(String(ticket.id));
    return {
      ...ticket,
      ...(batch
        ? shipSummary(batch)
        : {
            ship_block: null,
            settlement_default_idr: null,
            storage_fee_idr: null,
            settlement_cleared: null,
          }),
    };
  });
}

/** Work order dan PO satu tiket sampel, untuk detail tiket. */
export async function sampleProduction(client: Client, sampleId: string) {
  const [batch] = await rows(
    client,
    `${BATCH_LIST_SQL} WHERE b.sample_request_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 1;`,
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
    shipments: await rows(
      client,
      `${SHIPMENT_LIST_SQL} WHERE h.sample_request_id = ? ORDER BY h.created_at, h.id;`,
      [sampleId],
    ),
    storage_sop_text: (await loadBusinessSettings(client)).storage_sop_text,
    carriers: await rows(client, CARRIER_LIST_SQL),
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
    // PO terkunci setelah Penimbangan (keputusan G v3.2).
    if (Number(batch.stages_done ?? 0) > 0) invalid(PRODUCTION_STARTED);
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
    const locked = scheduleLockError(
      Number(batch.stages_done ?? 0),
      [
        String(batch.sched_weighing_on),
        String(batch.sched_mixing_on),
        String(batch.sched_filling_on),
        String(batch.sched_packing_on),
      ],
      [s.weighing_on, s.mixing_on, s.filling_on, s.packing_on],
    );
    if (locked) invalid(locked);
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

/**
 * Tandai tahap lantai produksi berikutnya selesai (v3.2, PRD F-25). `stage`
 * = `{ notes, carton_count, produced_units }`. Cermin
 * `desktop_record_batch_stage`.
 */
export async function recordBatchStage(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const batchId = id(input.batch_id);
  const transaction = await client.transaction("write");
  try {
    const batch = await findBatch(transaction, batchId);
    const done = Number(batch.stages_done ?? 0);
    const blocked = stageGateError({
      stages_done: done,
      material_status: String(batch.material_status),
      has_schedule: String(batch.sched_packing_on ?? "") !== "",
      legal_open: Number(batch.legal_open ?? 0),
    });
    if (blocked) invalid(blocked);
    const checked = validateStageRecord(input.stage, done);
    if ("error" in checked) invalid(checked.error);
    const record = checked.record;
    const name = PRODUCTION_STAGES[done] as ProductionStage;
    const notes = stageLogNotes(name, record);
    const { stamp } = await clock(transaction);
    const changed = await transaction.execute({
      sql: BATCH_STAGE_SQL,
      args: [
        batchId,
        done + 1,
        stamp,
        record.packing?.carton_count ?? 0,
        record.packing?.produced_units ?? 0,
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
      from: done > 0 ? (PRODUCTION_STAGES[done - 1] ?? "") : "",
      to: name,
      action: `STAGE_${name}`,
      notes,
      actor,
      stamp,
    });
    if (record.packing) {
      // Packing selesai (US-22): CS dan Finance menyiapkan pelunasan.
      await transaction.execute({
        sql: NOTIFY_BATCH_PACKED_SQL,
        args: [logId, batchId],
      });
    }
    await writeAudit(transaction, actor, "batch.stage", "sample", sampleId, {
      client_code: String(batch.client_code ?? ""),
      brand_name: String(batch.brand_name ?? ""),
      batch_code: String(batch.batch_code),
      stage: name,
      notes,
    });
    await transaction.commit();
    return { id: batchId, stages_done: done + 1 };
  } finally {
    transaction.close();
  }
}

/** Alasan batal pengiriman: wajib, paling banyak 500 karakter. */
function shipmentCancelReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason || [...reason].length > PRODUCTION_REASON_MAX) {
    invalid(SHIPMENT_CANCEL_REASON_INVALID);
  }
  return reason;
}

async function carrierUsable(executor: Executor, shipment: ShipmentInput) {
  if (shipment.method !== "CARRIER") return;
  const [option] = await rows(
    executor,
    "SELECT is_active FROM master_option WHERE id = ? AND kind = 'CARRIER';",
    [shipment.carrier_option_id],
  );
  if (!option || Number(option.is_active) !== 1) {
    invalid("Choose an active shipping company.");
  }
}

/**
 * Terbitkan Surat Jalan untuk work order yang siap kirim (v3.4, keputusan G).
 * Cermin `desktop_create_shipment`.
 */
export async function createShipment(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const batchId = id(input.batch_id);
  const checked = validateShipment(input.shipment);
  if ("error" in checked) invalid(checked.error);
  const shipment = checked.shipment;
  const transaction = await client.transaction("write");
  try {
    const batch = await findBatch(transaction, batchId);
    const [active] = await rows(transaction, SHIPMENT_ACTIVE_SQL, [
      batchId,
      "",
    ]);
    const blocked = shipmentRequestError(
      shipGateError(shipStateFromRow(batch)),
      Number(active?.total ?? 0),
    );
    if (blocked) invalid(blocked);
    await carrierUsable(transaction, shipment);
    const { epoch, stamp } = await clock(transaction);
    const codes = await getClientCodeSettings(transaction);
    const tag = codes.client_code_web_tag;
    const dateStamp = companyDateStamp(
      epoch,
      await companyTimezone(transaction),
    );
    const existing = await rows(
      transaction,
      "SELECT delivery_note_no FROM shipments WHERE delivery_note_no LIKE ?;",
      [`%-${dateStamp}-${tag}__`],
    );
    const sequence = nextClientSequence(
      existing.map((row) => String(row.delivery_note_no)),
      dateStamp,
      tag,
    );
    const number =
      sequence == null
        ? null
        : formatClientCode(
            codes.delivery_note_prefix,
            dateStamp,
            tag,
            sequence,
          );
    if (!number) {
      throw new ApiRequestError(
        "The Web has used up its delivery note numbers for today.",
        409,
      );
    }
    const shipmentId = crypto.randomUUID();
    const sampleId = String(batch.sample_request_id);
    await transaction.execute({
      sql: SHIPMENT_INSERT_SQL,
      args: [
        shipmentId,
        batchId,
        sampleId,
        String(batch.client_id),
        number,
        shipment.method,
        shipment.carrier_option_id,
        shipment.driver_name,
        shipment.driver_phone,
        shipment.vehicle_plate,
        shipment.carton_count,
        shipment.unit_count,
        shipment.ship_on,
        shipment.ship_to_address,
        shipment.notes,
        actor.id,
        stamp,
      ],
    });
    await log(transaction, {
      id: crypto.randomUUID(),
      sampleId,
      from: "",
      to: "PREPARED",
      action: SHIPMENT_CREATE_ACTION,
      notes: `Delivery note ${number}`,
      actor,
      stamp,
    });
    await writeAudit(
      transaction,
      actor,
      "shipment.create",
      "sample",
      sampleId,
      {
        client_code: String(batch.client_code ?? ""),
        brand_name: String(batch.brand_name ?? ""),
        batch_code: String(batch.batch_code),
        delivery_note_no: number,
      },
    );
    await transaction.commit();
    return { id: shipmentId, delivery_note_no: number };
  } finally {
    transaction.close();
  }
}

/**
 * Satu langkah pengiriman (v3.4, keputusan A). `step` = `{ action, shipment,
 * tracking_no, reason, evidence_base64 }`. Izin per langkah diperiksa route
 * (`shipmentActionPermission`). Cermin `desktop_record_shipment_step`.
 */
export async function recordShipmentStep(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const shipmentId = id(input.shipment_id);
  const step =
    input.step && typeof input.step === "object" ? (input.step as Draft) : {};
  const action = typeof step.action === "string" ? step.action : "";
  if (!(SHIPMENT_ACTIONS as readonly string[]).includes(action)) {
    invalid("This shipment step does not exist.");
  }
  let update: ShipmentInput | null = null;
  if (action === "SHIP_UPDATE") {
    const checked = validateShipment(step.shipment);
    if ("error" in checked) invalid(checked.error);
    update = checked.shipment;
  }
  let tracking = "";
  if (action === "SHIP_DISPATCH" || action === "SHIP_TRACKING") {
    const normalized = normalizeTracking(
      step.tracking_no,
      action === "SHIP_TRACKING",
    );
    if (normalized === null) invalid(TRACKING_INVALID);
    tracking = normalized;
  }
  const reason =
    action === "SHIP_CANCEL" ? shipmentCancelReason(step.reason) : "";
  let evidence: { data: string; size: number } | null = null;
  if (
    action === "SHIP_DISPATCH" &&
    typeof step.evidence_base64 === "string" &&
    step.evidence_base64
  ) {
    const media = validateMediaUpload("SHIPMENT_PROOF", step.evidence_base64);
    if ("error" in media) invalid(media.error);
    evidence = { data: step.evidence_base64, size: media.byte_size };
  }
  const transaction = await client.transaction("write");
  try {
    const [current] = await rows(
      transaction,
      `${SHIPMENT_LIST_SQL} WHERE h.id = ?;`,
      [shipmentId],
    );
    if (!current) throw new ApiRequestError("Shipment not found.", 404);
    if (update) await carrierUsable(transaction, update);
    const field = (key: string) => String(current[key] ?? "");
    const baseStatus = field("status");
    const next = applyShipmentAction(
      {
        status: baseStatus,
        method: field("method"),
        tracking_no: field("tracking_no"),
      },
      action,
    );
    if ("error" in next) invalid(next.error);
    const notes = shipmentLogNotes(action, {
      delivery_note_no: field("delivery_note_no"),
      method: field("method"),
      carrier_label: field("carrier_label"),
      tracking_no: tracking || field("tracking_no"),
      driver_name: field("driver_name"),
      vehicle_plate: field("vehicle_plate"),
      reason,
    });
    const { stamp } = await clock(transaction);
    const changed = update
      ? await transaction.execute({
          sql: SHIPMENT_UPDATE_SQL,
          args: [
            shipmentId,
            update.method,
            update.carrier_option_id,
            update.driver_name,
            update.driver_phone,
            update.vehicle_plate,
            update.carton_count,
            update.unit_count,
            update.ship_on,
            update.ship_to_address,
            update.notes,
            stamp,
            field("updated_at"),
          ],
        })
      : await transaction.execute({
          sql: SHIPMENT_STEP_SQL,
          args: [
            shipmentId,
            next.status,
            tracking,
            reason,
            stamp,
            baseStatus,
            field("updated_at"),
          ],
        });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(SHIPMENT_CHANGED_ELSEWHERE, 409);
    }
    const sampleId = field("sample_request_id");
    if (evidence) {
      await transaction.execute({
        sql: MEDIA_INSERT_SQL,
        args: [
          crypto.randomUUID(),
          sampleId,
          "SHIPMENT_PROOF",
          evidence.size,
          evidence.data,
          actor.id,
          stamp,
        ],
      });
    }
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
    if (action === "SHIP_DISPATCH") {
      // Barang keluar (keputusan H): CS meneruskan resi ke klien.
      await transaction.execute({
        sql: NOTIFY_SHIPPED_SQL,
        args: [logId, shipmentId],
      });
    }
    await writeAudit(transaction, actor, "shipment.step", "sample", sampleId, {
      client_code: field("client_code"),
      brand_name: field("brand_name"),
      delivery_note_no: field("delivery_note_no"),
      action,
      notes,
    });
    await transaction.commit();
    return { id: shipmentId, status: next.status };
  } finally {
    transaction.close();
  }
}
