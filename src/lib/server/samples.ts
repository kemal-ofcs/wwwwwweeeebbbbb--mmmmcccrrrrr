import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { listSampleMedia } from "@/lib/server/media";
import {
  applyDesignAction,
  DESIGN_ACTIVE_SQL,
  DESIGN_BRIEF_INVALID,
  DESIGN_CHANGED_ELSEWHERE,
  DESIGN_INSERT_SQL,
  DESIGN_LIST_SQL,
  DESIGN_REQUEST_ACTION,
  DESIGN_TRANSITION_SQL,
  designRequestError,
  dummyLimitReached,
  normalizeDesignBrief,
  normalizeTrackingNo,
  TRACKING_NO_INVALID,
} from "@/lib/validations/design";
import { INVOICE_LIST_SQL } from "@/lib/validations/finance";
import { MOU_LIST_SQL } from "@/lib/validations/mou";
import {
  NOTIFY_DESIGN_SQL,
  NOTIFY_SAMPLE_PRICED_SQL,
  NOTIFY_SAMPLE_STATUS_SQL,
} from "@/lib/validations/notification";
import {
  applySampleAction,
  CLIENT_LIFECYCLE_FROM_SAMPLES_SQL,
  computeUnitPrice,
  isSampleAction,
  normalizeSampleNotes,
  PRICE_COST_COLUMNS,
  PRICE_INSERT_SQL,
  PRICES_SQL,
  SAMPLE_ACTION_DIVISION,
  SAMPLE_CHANGED_ELSEWHERE,
  SAMPLE_FEEDBACK_INSERT_SQL,
  SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT,
  SAMPLE_FORMULA_INSERT_SQL,
  SAMPLE_FORMULA_MATCHES_SQL,
  SAMPLE_FORMULAS_SQL,
  SAMPLE_INSERT_SQL,
  SAMPLE_LIST_SQL,
  SAMPLE_STATUS_LOG_INSERT_SQL,
  SAMPLE_STEP_NOT_ALLOWED,
  SAMPLE_TERMINAL_STATUSES,
  SAMPLE_TRANSITION_SQL,
  SAMPLE_UPDATE_SQL,
  type SampleDraft,
  type SampleFeeMode,
  type SampleStatus,
  validateRndStep,
  validateSampleDraft,
} from "@/lib/validations/sample";

/**
 * Tiket sampel — jalur Web (PRD FR-06). Cermin `desktop_list_sample_requests`,
 * `desktop_get_sample_request`, `desktop_create_sample_request`,
 * `desktop_update_sample_request`, dan `desktop_record_sample_step` di
 * `commands.rs`. SQL dan aturan langkahnya bersama (`sample.ts` ↔ `samples.rs`).
 * Tiket desain (v2.4) ada di sini juga karena langkahnya menulis linimasa
 * tiket sampel yang sama (`design.ts` ↔ `design.rs`).
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

async function findSample(executor: Executor, id: string) {
  const result = await executor.execute({
    sql: `${SAMPLE_LIST_SQL} WHERE s.id = ?;`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new ApiRequestError("Sample request not found.", 404);
  return plain(row);
}

export async function listSampleRequests(client: Client) {
  const result = await client.execute(
    `${SAMPLE_LIST_SQL} ORDER BY s.created_at DESC, s.id;`,
  );
  const settings = await loadBusinessSettings(client);
  return {
    requests: result.rows.map(plain),
    sample_fee_mode: settings.sample_fee_mode,
  };
}

/**
 * Harga per iterasi tiket. Tanpa `pricing.view` rincian biaya dan margin
 * dibuang; harga jual tetap terbaca (keputusan H v2.2). Cermin `sample_prices`.
 */
async function listSamplePrices(
  client: Client,
  id: string,
  withCosts: boolean,
) {
  const result = await client.execute({ sql: PRICES_SQL, args: [id] });
  return result.rows.map((row) => {
    const price = plain(row);
    if (!withCosts) {
      for (const column of PRICE_COST_COLUMNS) delete price[column];
    }
    return price;
  });
}

export async function getSampleRequest(
  client: Client,
  id: unknown,
  withCosts: boolean,
) {
  const key = typeof id === "string" ? id.trim() : "";
  const request = await findSample(client, key);
  const statusLog = await client.execute({
    sql: "SELECT l.*, o.nama_operator AS recorded_by_name FROM sample_status_log l LEFT JOIN master_operator o ON o.id = l.recorded_by WHERE l.sample_request_id = ? ORDER BY l.recorded_at DESC, l.rowid DESC;",
    args: [key],
  });
  const feedbacks = await client.execute({
    sql: "SELECT * FROM sample_feedbacks WHERE sample_request_id = ? ORDER BY iteration_number, recorded_at;",
    args: [key],
  });
  const formulas = await client.execute({
    sql: SAMPLE_FORMULAS_SQL,
    args: [key],
  });
  const formulaMatches = await client.execute({
    sql: SAMPLE_FORMULA_MATCHES_SQL,
    args: [key],
  });
  const settings = await loadBusinessSettings(client);
  return {
    request,
    status_log: statusLog.rows.map(plain),
    feedbacks: feedbacks.rows.map(plain),
    media: await listSampleMedia(client, key),
    formulas: formulas.rows.map(plain),
    formula_matches: formulaMatches.rows.map(plain),
    prices: await listSamplePrices(client, key, withCosts),
    invoices: (
      await client.execute({
        sql: `${INVOICE_LIST_SQL} WHERE i.sample_request_id = ? ORDER BY i.created_at, i.id;`,
        args: [key],
      })
    ).rows.map(plain),
    // Tiket desain aktif, atau yang terakhir dibatalkan (v2.4).
    design:
      (
        await client.execute({
          sql: `${DESIGN_LIST_SQL} WHERE d.sample_request_id = ? ORDER BY d.status = 'CANCELLED', d.created_at DESC, d.rowid DESC LIMIT 1;`,
          args: [key],
        })
      ).rows.map(plain)[0] ?? null,
    max_dummy_rejections: settings.max_dummy_rejections,
    // MoU aktif, atau yang terakhir dibatalkan/ditolak (v2.5a).
    mou:
      (
        await client.execute({
          sql: `${MOU_LIST_SQL} WHERE m.sample_request_id = ? ORDER BY m.status IN ('CANCELLED', 'REJECTED'), m.created_at DESC, m.rowid DESC LIMIT 1;`,
          args: [key],
        })
      ).rows.map(plain)[0] ?? null,
    dp_percentage_bp: settings.dp_percentage_bp,
  };
}

async function optionUsable(
  executor: Executor,
  id: string,
  kind: string,
  current: unknown,
) {
  if (!id) return false;
  const result = await executor.execute({
    sql: "SELECT is_active FROM master_option WHERE id = ? AND kind = ?;",
    args: [id, kind],
  });
  const row = result.rows[0];
  if (!row) return false;
  return Number(row.is_active) === 1 || current === id;
}

/** Cermin `check_sample_references`; pesan identik. */
async function checkSampleReferences(
  executor: Executor,
  draft: SampleDraft,
  current: Record<string, unknown> | null,
) {
  if (
    !(await optionUsable(
      executor,
      draft.product_category_option_id,
      "PRODUCT_CATEGORY",
      current?.product_category_option_id,
    ))
  ) {
    invalid("Choose an active product type.");
  }
  for (const [key, kind, message] of [
    ["sample_kind_option_id", "SAMPLE_KIND", "Choose an active sample kind."],
    [
      "formulation_type_option_id",
      "FORMULATION_TYPE",
      "Choose an active formulation type.",
    ],
    [
      "registration_category_option_id",
      "REGISTRATION_CATEGORY",
      "Choose an active registration category.",
    ],
  ] as const) {
    const id = draft[key];
    if (id && !(await optionUsable(executor, id, kind, current?.[key]))) {
      invalid(message);
    }
  }
  if (draft.pic_crm_id !== null) {
    const unchanged = Number(current?.pic_crm_id ?? 0) === draft.pic_crm_id;
    const crm = await executor.execute({
      sql: "SELECT COUNT(*) AS total FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE m.id = ? AND COALESCE(m.status, 'Active') = 'Active' AND r.role_key = 'crm';",
      args: [draft.pic_crm_id],
    });
    if (Number(crm.rows[0]?.total) === 0 && !unchanged) {
      invalid("Choose an active CRM operator.");
    }
  }
}

/** Cermin `sample_draft_from_row`. */
function draftFromRow(row: Record<string, unknown>): Draft {
  let special: unknown = {};
  try {
    special = JSON.parse(String(row.special_requests_json ?? "{}"));
  } catch {
    special = {};
  }
  return {
    product_category_option_id: row.product_category_option_id,
    sample_kind_option_id: row.sample_kind_option_id,
    formulation_type_option_id: row.formulation_type_option_id,
    registration_category_option_id: row.registration_category_option_id,
    pic_crm_id: row.pic_crm_id == null ? null : Number(row.pic_crm_id),
    sample_qty: Number(row.sample_qty),
    brand_name: row.brand_name,
    bpom_product_name: row.bpom_product_name,
    claims: row.claims,
    packaging: row.packaging,
    reference_notes: row.reference_notes,
    client_budget_idr:
      row.client_budget_idr == null ? null : Number(row.client_budget_idr),
    special_requests: special,
    deadline_at: row.deadline_at,
    ship_to_address: row.ship_to_address,
    is_dummy_required: Number(row.is_dummy_required) === 1,
    is_paid_sample: Number(row.is_paid_sample) === 1,
    is_test_requested: Number(row.is_test_requested) === 1,
  };
}

function checked(draft: Draft, mode: SampleFeeMode) {
  const result = validateSampleDraft(draft, mode);
  if ("error" in result) invalid(result.error);
  return result.draft;
}

async function databaseNow(executor: Executor) {
  const clock = await executor.execute("SELECT datetime('now') AS stamp;");
  return String(clock.rows[0]?.stamp);
}

/** Tiket pertama mengubah klien `LEAD` → `FIRST_ORDER_ACTIVE` (D-09). */
export async function createSampleRequest(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const clientId = typeof input.client_id === "string" ? input.client_id : "";
  const transaction = await client.transaction("write");
  try {
    const owner = await transaction.execute({
      sql: "SELECT c.client_code, COALESCE(l.id, '') AS lead_id FROM clients c LEFT JOIN leads l ON l.client_id = c.id WHERE c.id = ? LIMIT 1;",
      args: [clientId],
    });
    const row = owner.rows[0];
    if (!row) throw new ApiRequestError("Client not found.", 404);
    const settings = await loadBusinessSettings(transaction);
    const draft = checked(input, settings.sample_fee_mode);
    await checkSampleReferences(transaction, draft, null);

    const id = crypto.randomUUID();
    const now = await databaseNow(transaction);
    await transaction.execute({
      sql: SAMPLE_INSERT_SQL,
      args: [
        id,
        clientId,
        String(row.lead_id),
        draft.sample_kind_option_id,
        draft.formulation_type_option_id,
        draft.registration_category_option_id,
        draft.product_category_option_id,
        draft.pic_crm_id,
        draft.sample_qty,
        draft.brand_name,
        draft.bpom_product_name,
        draft.claims,
        draft.packaging,
        draft.reference_notes,
        draft.client_budget_idr,
        draft.special_requests_json,
        draft.deadline_at,
        draft.ship_to_address,
        draft.is_dummy_required ? 1 : 0,
        draft.is_paid_sample ? 1 : 0,
        now,
        actor.id,
        draft.is_test_requested ? 1 : 0,
      ],
    });
    await transaction.execute({
      sql: CLIENT_LIFECYCLE_FROM_SAMPLES_SQL,
      args: [clientId, now],
    });
    // Tiket gratis ditandai di audit (OQ-28).
    await writeAudit(transaction, actor, "sample.create", "sample", id, {
      client_code: String(row.client_code),
      brand_name: draft.brand_name,
      is_paid_sample: draft.is_paid_sample,
    });
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/** Setelah dikirim ke RnD hanya field `SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT`. */
export async function updateSampleRequest(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const transaction = await client.transaction("write");
  try {
    const current = await findSample(transaction, id);
    const status = String(current.status);
    if (SAMPLE_TERMINAL_STATUSES.includes(status as SampleStatus)) {
      invalid("This sample request is closed.");
    }
    let merged: Draft = input;
    let mode: SampleFeeMode;
    if (status === "DRAFT") {
      mode = (await loadBusinessSettings(transaction)).sample_fee_mode;
    } else {
      merged = draftFromRow(current);
      for (const key of SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT) {
        merged[key] = input[key] ?? null;
      }
      mode = Number(current.is_paid_sample) === 1 ? "PAID" : "FREE";
    }
    const draft = checked(merged, mode);
    await checkSampleReferences(transaction, draft, current);

    const now = await databaseNow(transaction);
    const result = await transaction.execute({
      sql: SAMPLE_UPDATE_SQL,
      args: [
        id,
        draft.sample_kind_option_id,
        draft.formulation_type_option_id,
        draft.registration_category_option_id,
        draft.product_category_option_id,
        draft.sample_qty,
        draft.brand_name,
        draft.bpom_product_name,
        draft.claims,
        draft.packaging,
        draft.reference_notes,
        draft.special_requests_json,
        draft.is_dummy_required ? 1 : 0,
        draft.is_paid_sample ? 1 : 0,
        draft.pic_crm_id,
        draft.client_budget_idr,
        draft.deadline_at,
        draft.ship_to_address,
        now,
        draft.is_test_requested ? 1 : 0,
      ],
    });
    if (result.rowsAffected === 0) invalid("This sample request is closed.");
    await writeAudit(transaction, actor, "sample.update", "sample", id, {
      client_code: String(current.client_code),
      brand_name: draft.brand_name,
    });
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/**
 * Catat satu langkah (FR-06.4). Langkah RnD/Finance dicatat atas nama divisi
 * itu (D-23). Izin per langkah (`sampleActionPermission`) diperiksa route.
 * Status dan revisi dicocokkan di SQL: bila perangkat lain sudah memindahkan
 * tiket lebih dulu, langkah ini ditolak, bukan menimpa.
 */
export async function recordSampleStep(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const action = input.action;
  if (!isSampleAction(action)) invalid(SAMPLE_STEP_NOT_ALLOWED);
  const notes = normalizeSampleNotes(input.notes);
  if (!notes) invalid("Notes are required, up to 1000 characters.");
  const checkedRnd = validateRndStep(action, input.rnd);
  if ("error" in checkedRnd) invalid(checkedRnd.error);
  const rnd = checkedRnd.rnd;
  if (
    rnd.reject_reason_option_id !== null &&
    !(await optionUsable(
      client,
      rnd.reject_reason_option_id,
      "RND_REJECT_REASON",
      null,
    ))
  ) {
    invalid("Choose an active rejection reason.");
  }
  const leadTime =
    action === "RND_ACCEPT" &&
    typeof input.lead_time_days === "number" &&
    Number.isSafeInteger(input.lead_time_days)
      ? input.lead_time_days
      : null;
  const fee =
    action === "SET_REVISION_FEE" && typeof input.revision_fee_idr === "number"
      ? input.revision_fee_idr
      : null;

  const transaction = await client.transaction("write");
  try {
    const current = await findSample(transaction, id);
    const baseStatus = String(current.status);
    const baseIndex = Number(current.revision_index ?? 0);
    const result = applySampleAction(
      {
        status: baseStatus,
        is_paid_sample: Number(current.is_paid_sample) === 1,
        revision_index: baseIndex,
        free_revision_limit: Number(current.free_revision_limit ?? 0),
        has_price: current.unit_price_idr != null,
        fee_paid: Number(current.fee_paid) === 1,
        test_ready:
          Number(current.is_test_requested) !== 1 ||
          Number(current.test_paid) === 1,
        mockup_ready: Number(current.mockup_ready) === 1,
      },
      action,
      leadTime,
      fee,
    );
    if ("error" in result) invalid(result.error);
    const division = SAMPLE_ACTION_DIVISION[action];
    const now = await databaseNow(transaction);
    const changed = await transaction.execute({
      sql: SAMPLE_TRANSITION_SQL,
      args: [
        id,
        result.status,
        result.revision_index,
        result.is_billable === null ? null : result.is_billable ? 1 : 0,
        leadTime,
        now,
        baseStatus,
        baseIndex,
        rnd.product_class,
        rnd.reject_reason_option_id,
        fee,
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(SAMPLE_CHANGED_ELSEWHERE, 409);
    }
    if (rnd.formula_code !== null) {
      // Iterasi ke-n = revisi ke-(n-1), sama dengan `sample_feedbacks`.
      await transaction.execute({
        sql: SAMPLE_FORMULA_INSERT_SQL,
        args: [
          crypto.randomUUID(),
          id,
          baseIndex + 1,
          rnd.formula_code,
          rnd.product_knowledge,
          notes,
          actor.id,
          now,
        ],
      });
    }
    const logId = crypto.randomUUID();
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        logId,
        id,
        baseStatus,
        result.status,
        action,
        notes,
        division ?? actor.role,
        actor.id,
        now,
      ],
    });
    // Antrean RnD/Finance (PRD FR-08); status lain tidak menulis apa pun.
    await transaction.execute({
      sql: NOTIFY_SAMPLE_STATUS_SQL,
      args: [logId, id],
    });
    if (result.client_decision) {
      await transaction.execute({
        sql: SAMPLE_FEEDBACK_INSERT_SQL,
        args: [
          crypto.randomUUID(),
          id,
          baseIndex + 1,
          result.client_decision,
          notes,
          actor.id,
          now,
        ],
      });
    }
    await transaction.execute({
      sql: CLIENT_LIFECYCLE_FROM_SAMPLES_SQL,
      args: [String(current.client_id), now],
    });
    await writeAudit(
      transaction,
      actor,
      "sample.step",
      "sample",
      id,
      {
        client_code: String(current.client_code),
        brand_name: String(current.brand_name),
        action,
        from: baseStatus,
        to: result.status,
        revision_index: result.revision_index,
        notes,
        product_class: rnd.product_class,
        formula_code: rnd.formula_code,
        revision_fee_idr: fee,
      },
      division,
    );
    await transaction.commit();
    return { status: result.status, revision_index: result.revision_index };
  } finally {
    transaction.close();
  }
}

/**
 * Brief desain untuk tiket sampel (v2.4, PRD F-19, keputusan A). Cermin
 * `desktop_create_design_ticket`.
 */
export async function createDesignTicket(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const sampleId =
    typeof input.sample_id === "string" ? input.sample_id.trim() : "";
  const brief = normalizeDesignBrief(input.brief);
  if (!brief) invalid(DESIGN_BRIEF_INVALID);
  const transaction = await client.transaction("write");
  try {
    const current = await findSample(transaction, sampleId);
    const active = await transaction.execute({
      sql: DESIGN_ACTIVE_SQL,
      args: [sampleId, ""],
    });
    const blocked = designRequestError(
      String(current.status),
      Number(active.rows[0]?.total ?? 0),
    );
    if (blocked) invalid(blocked);
    const now = await databaseNow(transaction);
    const id = crypto.randomUUID();
    const logId = crypto.randomUUID();
    await transaction.execute({
      sql: DESIGN_INSERT_SQL,
      args: [id, sampleId, brief, now, actor.id],
    });
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        logId,
        sampleId,
        "",
        "MOCKUP",
        DESIGN_REQUEST_ACTION,
        brief,
        "",
        actor.id,
        now,
      ],
    });
    // Grup Desain (PRD FR-08), di transaksi yang sama.
    await transaction.execute({ sql: NOTIFY_DESIGN_SQL, args: [logId, id] });
    await writeAudit(transaction, actor, "design.request", "sample", sampleId, {
      client_code: String(current.client_code),
      brand_name: String(current.brand_name),
      brief,
    });
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/**
 * Satu langkah tiket desain (v2.4). `canOverride` = pencatat memegang
 * `design.override_dummy_limit` (keputusan E). Cermin
 * `desktop_record_design_step`.
 */
export async function recordDesignStep(
  client: Client,
  input: Draft,
  actor: AuditActor,
  canOverride: boolean,
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const action = typeof input.action === "string" ? input.action : "";
  const notes = normalizeSampleNotes(input.notes);
  if (!notes) invalid("Notes are required, up to 1000 characters.");
  const tracking = normalizeTrackingNo(input.tracking_no);
  if (tracking === null) invalid(TRACKING_NO_INVALID);

  const transaction = await client.transaction("write");
  try {
    const found = await transaction.execute({
      sql: `${DESIGN_LIST_SQL} WHERE d.id = ?;`,
      args: [id],
    });
    const row = found.rows[0];
    if (!row) throw new ApiRequestError("Design ticket not found.", 404);
    const current = plain(row);
    const maxRejections = (await loadBusinessSettings(transaction))
      .max_dummy_rejections;
    const baseStatus = String(current.status);
    const baseCount = Number(current.dummy_rejection_count ?? 0);
    const override =
      action === "PRINT_DUMMY" &&
      dummyLimitReached(baseCount, maxRejections) &&
      canOverride;
    const step = applyDesignAction(
      {
        status: baseStatus,
        sample_status: String(current.sample_status),
        has_mockup: Number(current.has_mockup) === 1,
        dummy_paid: Number(current.dummy_paid) === 1,
        rejection_count: baseCount,
        max_rejections: maxRejections,
        can_override: override,
      },
      action,
    );
    if ("error" in step) invalid(step.error);
    const result = step.result;
    const sampleId = String(current.sample_request_id);
    const now = await databaseNow(transaction);
    const changed = await transaction.execute({
      sql: DESIGN_TRANSITION_SQL,
      args: [
        id,
        result.status,
        result.rejection_count,
        // Resi hanya pada langkah kirim, catatan revisi hanya pada revisi.
        action === "DUMMY_SENT" ? tracking : null,
        action === "DUMMY_REVISE" ? notes : null,
        now,
        baseStatus,
        baseCount,
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(DESIGN_CHANGED_ELSEWHERE, 409);
    }
    const logId = crypto.randomUUID();
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        logId,
        sampleId,
        baseStatus,
        result.status,
        action,
        notes,
        "",
        actor.id,
        now,
      ],
    });
    await transaction.execute({ sql: NOTIFY_DESIGN_SQL, args: [logId, id] });
    await writeAudit(transaction, actor, "design.step", "sample", sampleId, {
      client_code: String(current.client_code),
      brand_name: String(current.brand_name),
      action,
      from: baseStatus,
      to: result.status,
      rejection_count: result.rejection_count,
      tracking_no: action === "DUMMY_SENT" ? tracking : null,
      override_limit: override,
      notes,
    });
    await transaction.commit();
    return result;
  } finally {
    transaction.close();
  }
}

/**
 * Simpan harga Finance untuk iterasi yang sedang berjalan (v2.2, PRD F-16,
 * D-27). Hanya saat `SAMPLE_READY`; harga jual dihitung `computeUnitPrice`,
 * tidak dipercaya dari form. Cermin `desktop_record_sample_price`.
 */
export async function recordSamplePrice(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const checked = computeUnitPrice(input.price);
  if ("error" in checked) invalid(checked.error);
  const price = checked.price;

  const transaction = await client.transaction("write");
  try {
    const current = await findSample(transaction, id);
    if (current.status !== "SAMPLE_READY") {
      invalid("Only a sample that is ready can be priced.");
    }
    const iteration = Number(current.revision_index ?? 0) + 1;
    const now = await databaseNow(transaction);
    const priceId = crypto.randomUUID();
    await transaction.execute({
      sql: PRICE_INSERT_SQL,
      args: [
        priceId,
        id,
        iteration,
        price.raw_material_cost_idr,
        price.packaging_cost_idr,
        price.operational_cost_idr,
        price.regulatory_cost_idr,
        price.hpp_unit_idr,
        price.margin_bp,
        price.final_unit_price_idr,
        price.notes,
        actor.id,
        now,
      ],
    });
    // Grup CS: sampel boleh dikirim (PRD FR-08).
    await transaction.execute({
      sql: NOTIFY_SAMPLE_PRICED_SQL,
      args: [priceId],
    });
    await writeAudit(
      transaction,
      actor,
      "sample.price",
      "sample",
      id,
      {
        client_code: String(current.client_code),
        brand_name: String(current.brand_name),
        iteration_number: iteration,
        final_unit_price_idr: price.final_unit_price_idr,
      },
      "Finance",
    );
    await transaction.commit();
    return { id: priceId, final_unit_price_idr: price.final_unit_price_idr };
  } finally {
    transaction.close();
  }
}
