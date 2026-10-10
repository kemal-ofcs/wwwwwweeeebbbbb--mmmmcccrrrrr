import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { companyTimezone, getClientCodeSettings } from "@/lib/server/clients";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { clientEvidence, insertClientEvidence } from "@/lib/server/media";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
} from "@/lib/validations/client";
import {
  applyMouAction,
  MOU_ACTIVE_SQL,
  MOU_CHANGED_ELSEWHERE,
  MOU_CREATE_ACTION,
  MOU_INSERT_SQL,
  MOU_LIST_SQL,
  MOU_NOT_EDITABLE,
  MOU_TRANSITION_SQL,
  MOU_UPDATE_SQL,
  mouRequestError,
  validateMouTerms,
} from "@/lib/validations/mou";
import { NOTIFY_MOU_SQL } from "@/lib/validations/notification";
import {
  normalizeSampleNotes,
  SAMPLE_LIST_SQL,
  SAMPLE_STATUS_LOG_INSERT_SQL,
} from "@/lib/validations/sample";

/**
 * MoU produksi (v2.5a, PRD F-20) — jalur Web. Cermin `desktop_create_mou`,
 * `desktop_update_mou`, dan `desktop_record_mou_step` di `commands.rs`.
 * Aturannya bersama (`mou.ts` ↔ `mou.rs`).
 */

type Executor = Client | Transaction;

/**
 * Pencatat langkah: staf (transaksi sendiri, jawaban klien wajib membawa
 * tangkapan layar) atau halaman tautan persetujuan (`viaLink`, memakai
 * transaksi pemanggil supaya token dipakai di transaksi yang sama).
 */
interface StepOptions {
  transaction?: Transaction;
  viaLink?: boolean;
}

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

async function clock(executor: Executor) {
  const result = await executor.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch, datetime('now') AS stamp;",
  );
  return {
    epoch: Number(result.rows[0]?.epoch),
    stamp: String(result.rows[0]?.stamp),
  };
}

async function findMou(executor: Executor, id: string) {
  const result = await executor.execute({
    sql: `${MOU_LIST_SQL} WHERE m.id = ?;`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new ApiRequestError("MoU not found.", 404);
  return plain(row);
}

/**
 * Isi MoU dari form. Harga satuan dan persen DP hanya diambil dari form bila
 * pencatat memegang `finance.manage`. Cermin `merge_mou_terms`.
 */
function mergeTerms(
  input: Draft,
  fallback: Record<string, unknown>,
  canEdit: boolean,
  canPrice: boolean,
) {
  const merged = { ...fallback };
  const take = (keys: string[]) => {
    for (const key of keys) merged[key] = input[key] ?? null;
  };
  if (canEdit) {
    take([
      "total_units",
      "production_lead_time_days",
      "regulatory_path",
      "notes",
    ]);
  }
  if (canPrice) take(["unit_price_idr", "dp_bp"]);
  return merged;
}

export async function createMou(
  client: Client,
  input: Draft,
  actor: AuditActor,
  canPrice: boolean,
) {
  const sampleId =
    typeof input.sample_id === "string" ? input.sample_id.trim() : "";
  const terms =
    input.terms && typeof input.terms === "object"
      ? (input.terms as Draft)
      : {};
  const transaction = await client.transaction("write");
  try {
    const found = await transaction.execute({
      sql: `${SAMPLE_LIST_SQL} WHERE s.id = ?;`,
      args: [sampleId],
    });
    const sample = found.rows[0] ? plain(found.rows[0]) : null;
    if (!sample) throw new ApiRequestError("Sample request not found.", 404);
    const active = await transaction.execute({
      sql: MOU_ACTIVE_SQL,
      args: [sampleId, ""],
    });
    const blocked = mouRequestError(
      String(sample.status),
      Number(active.rows[0]?.total ?? 0),
    );
    if (blocked) invalid(blocked);
    const settings = await loadBusinessSettings(transaction);
    const checked = validateMouTerms(
      mergeTerms(
        terms,
        {
          unit_price_idr: sample.unit_price_idr,
          dp_bp: settings.dp_percentage_bp,
        },
        true,
        canPrice,
      ),
    );
    if ("error" in checked) invalid(checked.error);
    const { epoch, stamp } = await clock(transaction);
    const codes = await getClientCodeSettings(transaction);
    const tag = codes.client_code_web_tag;
    const dateStamp = companyDateStamp(
      epoch,
      await companyTimezone(transaction),
    );
    const existing = await transaction.execute({
      sql: "SELECT mou_number FROM production_mou WHERE mou_number LIKE ?;",
      args: [`%-${dateStamp}-${tag}__`],
    });
    const sequence = nextClientSequence(
      existing.rows.map((row) => String(row.mou_number)),
      dateStamp,
      tag,
    );
    const number =
      sequence == null
        ? null
        : formatClientCode(codes.mou_number_prefix, dateStamp, tag, sequence);
    if (!number) {
      throw new ApiRequestError(
        "The Web has used up its MoU numbers for today.",
        409,
      );
    }
    const id = crypto.randomUUID();
    const t = checked.terms;
    await transaction.execute({
      sql: MOU_INSERT_SQL,
      args: [
        id,
        number,
        sampleId,
        String(sample.client_id),
        t.total_units,
        t.unit_price_idr,
        t.total_production_cost_idr,
        t.production_lead_time_days,
        t.regulatory_path,
        t.dp_bp,
        t.dp_amount_required_idr,
        t.notes,
        stamp,
        actor.id,
      ],
    });
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        crypto.randomUUID(),
        sampleId,
        "",
        "DRAFT",
        MOU_CREATE_ACTION,
        `MoU ${number}`,
        "",
        actor.id,
        stamp,
      ],
    });
    await writeAudit(transaction, actor, "mou.create", "sample", sampleId, {
      client_code: String(sample.client_code),
      brand_name: String(sample.brand_name),
      mou_number: number,
      terms: t,
    });
    await transaction.commit();
    return { id, mou_number: number };
  } finally {
    transaction.close();
  }
}

export async function updateMou(
  client: Client,
  input: Draft,
  actor: AuditActor,
  canEdit: boolean,
  canPrice: boolean,
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const terms =
    input.terms && typeof input.terms === "object"
      ? (input.terms as Draft)
      : {};
  const transaction = await client.transaction("write");
  try {
    const current = await findMou(transaction, id);
    if (current.status !== "DRAFT") invalid(MOU_NOT_EDITABLE);
    const checked = validateMouTerms(
      mergeTerms(terms, current, canEdit, canPrice),
    );
    if ("error" in checked) invalid(checked.error);
    const t = checked.terms;
    const { stamp } = await clock(transaction);
    const changed = await transaction.execute({
      sql: MOU_UPDATE_SQL,
      args: [
        id,
        t.total_units,
        t.unit_price_idr,
        t.total_production_cost_idr,
        t.production_lead_time_days,
        t.regulatory_path,
        t.dp_bp,
        t.dp_amount_required_idr,
        t.notes,
        stamp,
        String(current.updated_at),
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(MOU_CHANGED_ELSEWHERE, 409);
    }
    await writeAudit(
      transaction,
      actor,
      "mou.update",
      "sample",
      String(current.sample_request_id),
      {
        client_code: String(current.client_code),
        brand_name: String(current.brand_name),
        mou_number: String(current.mou_number),
        terms: t,
      },
    );
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

export async function recordMouStep(
  client: Client,
  input: Draft,
  actor: AuditActor,
  options: StepOptions = {},
) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const action = typeof input.action === "string" ? input.action : "";
  const notes = normalizeSampleNotes(input.notes);
  if (!notes) invalid("Notes are required, up to 1000 characters.");
  const evidence = clientEvidence(
    action,
    input.evidence_base64,
    options.viaLink === true,
  );
  const own = !options.transaction;
  const transaction =
    options.transaction ?? (await client.transaction("write"));
  try {
    const current = await findMou(transaction, id);
    const baseStatus = String(current.status);
    const step = applyMouAction(
      { status: baseStatus, dummy_ready: Number(current.dummy_ready) === 1 },
      action,
    );
    if ("error" in step) invalid(step.error);
    const status = step.result.status;
    const sampleId = String(current.sample_request_id);
    const { stamp } = await clock(transaction);
    const changed = await transaction.execute({
      sql: MOU_TRANSITION_SQL,
      args: [
        id,
        status,
        action === "MOU_REVISE" ? notes : null,
        stamp,
        baseStatus,
      ],
    });
    if (changed.rowsAffected === 0) {
      throw new ApiRequestError(MOU_CHANGED_ELSEWHERE, 409);
    }
    if (evidence) {
      await insertClientEvidence(
        transaction,
        sampleId,
        evidence,
        actor.id,
        stamp,
      );
    }
    const logId = crypto.randomUUID();
    await transaction.execute({
      sql: SAMPLE_STATUS_LOG_INSERT_SQL,
      args: [
        logId,
        sampleId,
        baseStatus,
        status,
        action,
        notes,
        "",
        actor.id,
        stamp,
      ],
    });
    // MoU disetujui klien: Finance menerbitkan tagihan DP (FR-08).
    await transaction.execute({ sql: NOTIFY_MOU_SQL, args: [logId, id] });
    await writeAudit(transaction, actor, "mou.step", "sample", sampleId, {
      client_code: String(current.client_code),
      brand_name: String(current.brand_name),
      mou_number: String(current.mou_number),
      action,
      from: baseStatus,
      to: status,
      notes,
    });
    if (own) await transaction.commit();
    return { status };
  } finally {
    if (own) transaction.close();
  }
}
