import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  applySampleAction,
  CLIENT_LIFECYCLE_FROM_SAMPLES_SQL,
  isSampleAction,
  normalizeSampleNotes,
  SAMPLE_ACTION_DIVISION,
  SAMPLE_CHANGED_ELSEWHERE,
  SAMPLE_FEEDBACK_INSERT_SQL,
  SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT,
  SAMPLE_INSERT_SQL,
  SAMPLE_STATUS_LOG_INSERT_SQL,
  SAMPLE_STEP_NOT_ALLOWED,
  SAMPLE_TERMINAL_STATUSES,
  SAMPLE_TRANSITION_SQL,
  SAMPLE_UPDATE_SQL,
  type SampleDraft,
  type SampleFeeMode,
  type SampleStatus,
  validateSampleDraft,
} from "@/lib/validations/sample";

/**
 * Tiket sampel — jalur Web (PRD FR-06). Cermin `desktop_list_sample_requests`,
 * `desktop_get_sample_request`, `desktop_create_sample_request`,
 * `desktop_update_sample_request`, dan `desktop_record_sample_step` di
 * `commands.rs`. SQL dan aturan langkahnya bersama (`sample.ts` ↔ `samples.rs`).
 */

type Executor = Client | Transaction;
type Draft = Record<string, unknown>;

const SAMPLE_LIST_SQL =
  "SELECT s.*, c.client_code, c.name AS client_name, c.free_revision_limit, o.nama_operator AS pic_crm_name FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN master_operator o ON o.id = s.pic_crm_id";

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

export async function getSampleRequest(client: Client, id: unknown) {
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
  return {
    request,
    status_log: statusLog.rows.map(plain),
    feedbacks: feedbacks.rows.map(plain),
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
 * itu (D-23). Status dan revisi dicocokkan di SQL: bila perangkat lain sudah
 * memindahkan tiket lebih dulu, langkah ini ditolak, bukan menimpa.
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
  const leadTime =
    action === "RND_ACCEPT" &&
    typeof input.lead_time_days === "number" &&
    Number.isSafeInteger(input.lead_time_days)
      ? input.lead_time_days
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
      },
      action,
      leadTime,
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
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(SAMPLE_CHANGED_ELSEWHERE, 409);
    }
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        crypto.randomUUID(),
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
      },
      division,
    );
    await transaction.commit();
    return { status: result.status, revision_index: result.revision_index };
  } finally {
    transaction.close();
  }
}
