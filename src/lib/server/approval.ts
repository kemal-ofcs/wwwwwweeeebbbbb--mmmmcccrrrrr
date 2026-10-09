import "server-only";

import type { Client, Transaction } from "@libsql/client";
import {
  createOpaqueSessionToken,
  hashSessionToken,
} from "@/lib/auth/session-token";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { recordMouStep } from "@/lib/server/mou";
import { recordDesignStep, recordSampleStep } from "@/lib/server/samples";
import {
  APPROVAL_INSERT_SQL,
  APPROVAL_INVALID,
  APPROVAL_LINK_DISABLED,
  APPROVAL_LINK_UNAVAILABLE,
  APPROVAL_LOOKUP_SQL,
  APPROVAL_REVOKE_OTHERS_SQL,
  APPROVAL_TARGET_SQL,
  APPROVAL_USE_SQL,
  type ApprovalDecision,
  type ApprovalEntityType,
  approvalStepAction,
  approvalUrl,
  isApprovalEntityType,
  validateApprovalResponse,
} from "@/lib/validations/approval";
import { DESIGN_LIST_SQL } from "@/lib/validations/design";
import { MOU_LIST_SQL } from "@/lib/validations/mou";
import { NOTIFY_CLIENT_RESPONSE_SQL } from "@/lib/validations/notification";
import { formatRupiah, SAMPLE_LIST_SQL } from "@/lib/validations/sample";

/**
 * Tautan persetujuan klien (v2.5b, PRD F-18, D-38) — jalur Web. Membuat
 * tautan cermin `desktop_create_approval_link`; membaca dan menerapkan
 * jawaban hanya ada di sini, karena halaman klien hanya ada di Web.
 */

type Executor = Client | Transaction;

/** Klien lewat tautan: tanpa id operator, dicatat sebagai `Client`. */
const CLIENT_ACTOR: AuditActor = { id: null, role: "Client" };

const REGULATORY_PATH_LABEL: Record<string, string> = {
  WHITE_LABEL: "White Label",
  WITH_BPOM: "Registered with BPOM",
};

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  APPROVE: "Approved",
  REVISE: "Changes requested",
  REJECT: "Rejected",
};

async function row(executor: Executor, sql: string, args: unknown[]) {
  const result = await executor.execute({
    sql,
    args: args as (string | number | null)[],
  });
  return result.rows[0] ?? null;
}

export async function createApprovalLink(
  client: Client,
  input: Record<string, unknown>,
  actor: AuditActor,
) {
  const entityType = input.entity_type;
  const entityId =
    typeof input.entity_id === "string" ? input.entity_id.trim() : "";
  if (!isApprovalEntityType(entityType)) {
    throw new ApiRequestError("This item cannot be sent for approval.", 400);
  }
  const settings = await loadBusinessSettings(client);
  if (!settings.approval_web_url) {
    throw new ApiRequestError(APPROVAL_LINK_DISABLED, 400);
  }
  const token = createOpaqueSessionToken();
  const id = crypto.randomUUID();
  const inserted = await client.execute({
    sql: APPROVAL_INSERT_SQL,
    args: [
      entityType,
      entityId,
      id,
      await hashSessionToken(token),
      settings.approval_token_ttl_days,
      actor.id,
    ],
  });
  if (inserted.rowsAffected === 0) {
    throw new ApiRequestError(APPROVAL_LINK_UNAVAILABLE, 409);
  }
  await client.execute({
    sql: APPROVAL_REVOKE_OTHERS_SQL,
    args: [entityType, entityId, id],
  });
  const stored = await row(
    client,
    "SELECT expires_at FROM approval_tokens WHERE id = ?;",
    [id],
  );
  return {
    url: approvalUrl(settings.approval_web_url, token),
    expires_at: String(stored?.expires_at ?? ""),
  };
}

async function companyContact(executor: Executor) {
  const company = await row(
    executor,
    "SELECT company_name, phone FROM company_profile WHERE id = 'default_company';",
    [],
  );
  return {
    name: String(company?.company_name ?? ""),
    phone: String(company?.phone ?? ""),
  };
}

/**
 * Token yang masih bisa dipakai beserta hal yang disetujuinya, atau `null`.
 * Hal itu harus masih di status dan putaran yang sama seperti saat tautan
 * dibuat: jawaban yang sudah dicatat manual membuat tautannya tidak sah.
 */
async function findValidToken(executor: Executor, token: string) {
  if (!token) return null;
  const stored = await row(executor, APPROVAL_LOOKUP_SQL, [
    await hashSessionToken(token),
  ]);
  if (!stored) return null;
  const target = await row(executor, APPROVAL_TARGET_SQL, [
    String(stored.entity_type),
    String(stored.entity_id),
  ]);
  const current =
    target &&
    String(target.status) === String(stored.base_status) &&
    Number(target.revision) === Number(stored.base_revision);
  return current ? stored : null;
}

/** Ringkasan untuk halaman klien; tanpa harga pokok atau data internal. */
async function summary(
  executor: Executor,
  entityType: ApprovalEntityType,
  entityId: string,
) {
  if (entityType === "MOU") {
    const mou = await row(executor, `${MOU_LIST_SQL} WHERE m.id = ?;`, [
      entityId,
    ]);
    return {
      client_name: String(mou?.client_name ?? ""),
      brand_name: String(mou?.brand_name ?? ""),
      details: [
        { label: "MoU number", value: String(mou?.mou_number ?? "") },
        {
          label: "Units",
          value: Number(mou?.total_units ?? 0).toLocaleString("id-ID"),
        },
        {
          label: "Unit price before tax",
          value: formatRupiah(Number(mou?.unit_price_idr ?? 0)),
        },
        {
          label: "Contract value",
          value: formatRupiah(Number(mou?.total_production_cost_idr ?? 0)),
        },
        {
          label: `Down payment (${Number(mou?.dp_bp ?? 0) / 100}%)`,
          value: formatRupiah(Number(mou?.dp_amount_required_idr ?? 0)),
        },
        {
          label: "Production lead time",
          value: `${Number(mou?.production_lead_time_days ?? 0)} days`,
        },
        {
          label: "Regulatory path",
          value:
            REGULATORY_PATH_LABEL[String(mou?.regulatory_path)] ??
            String(mou?.regulatory_path ?? ""),
        },
      ],
    };
  }
  if (entityType === "DUMMY") {
    const design = await row(executor, `${DESIGN_LIST_SQL} WHERE d.id = ?;`, [
      entityId,
    ]);
    return {
      client_name: String(design?.client_name ?? ""),
      brand_name: String(design?.brand_name ?? ""),
      details: [
        { label: "Packaging brief", value: String(design?.brief ?? "") },
        {
          label: "Dummy round",
          value: String(Number(design?.dummy_rejection_count ?? 0) + 1),
        },
        {
          label: "Tracking number",
          value: String(design?.dummy_tracking_no ?? "") || "-",
        },
      ],
    };
  }
  const sample = await row(executor, `${SAMPLE_LIST_SQL} WHERE s.id = ?;`, [
    entityId,
  ]);
  return {
    client_name: String(sample?.client_name ?? ""),
    brand_name: String(sample?.brand_name ?? ""),
    details: [
      {
        label: "Sample",
        value: `Iteration ${Number(sample?.revision_index ?? 0) + 1}`,
      },
      { label: "Quantity", value: String(sample?.sample_qty ?? "") },
      { label: "Packaging", value: String(sample?.packaging ?? "") },
      {
        label: "Unit price before tax",
        value:
          sample?.unit_price_idr == null
            ? "-"
            : formatRupiah(Number(sample.unit_price_idr)),
      },
    ],
  };
}

/**
 * Catat percobaan tautan yang tidak sah (E-24). Hanya awal hash yang
 * disimpan, supaya log tidak bisa dipakai menebak token.
 */
export async function recordInvalidApproval(client: Client, token: string) {
  const transaction = await client.transaction("write");
  try {
    const hash = token ? await hashSessionToken(token) : "";
    await writeAudit(
      transaction,
      CLIENT_ACTOR,
      "approval.invalid",
      "approval",
      hash.slice(0, 12) || "-",
      {},
    );
    await transaction.commit();
  } finally {
    transaction.close();
  }
}

/** Halaman klien: ringkasan bila tautan sah; kontak perusahaan selalu (E-24). */
export async function readApproval(client: Client, token: string) {
  const company = await companyContact(client);
  const stored = await findValidToken(client, token);
  if (!stored) return { valid: false as const, company };
  const entityType = String(stored.entity_type) as ApprovalEntityType;
  const decisions = (["APPROVE", "REVISE", "REJECT"] as const).filter(
    (decision) => approvalStepAction(entityType, decision) !== null,
  );
  return {
    valid: true as const,
    company,
    entity_type: entityType,
    decisions,
    expires_at: String(stored.expires_at),
    ...(await summary(client, entityType, String(stored.entity_id))),
  };
}

/**
 * Terapkan jawaban klien dengan aturan langkah yang sama seperti pencatatan
 * manual, di SATU transaksi bersama pemakaian token dan notifikasi CS.
 */
export async function respondApproval(
  client: Client,
  token: string,
  input: Record<string, unknown>,
) {
  const checked = validateApprovalResponse(input);
  if ("error" in checked) throw new ApiRequestError(checked.error, 400);
  const response = checked.response;
  const transaction = await client.transaction("write");
  try {
    const stored = await findValidToken(transaction, token);
    if (!stored) throw new ApiRequestError(APPROVAL_INVALID, 410);
    const entityType = String(stored.entity_type) as ApprovalEntityType;
    const entityId = String(stored.entity_id);
    const action = approvalStepAction(entityType, response.decision);
    if (!action) {
      throw new ApiRequestError("This answer is not available here.", 400);
    }
    const notes = `${response.responder_name} (approval link): ${
      response.notes || DECISION_LABEL[response.decision]
    }`;
    const step = { id: entityId, action, notes };
    const options = { transaction, viaLink: true };
    if (entityType === "SAMPLE") {
      await recordSampleStep(client, step, CLIENT_ACTOR, options);
    } else if (entityType === "DUMMY") {
      await recordDesignStep(client, step, CLIENT_ACTOR, false, options);
    } else {
      await recordMouStep(client, step, CLIENT_ACTOR, options);
    }
    const used = await transaction.execute({
      sql: APPROVAL_USE_SQL,
      args: [String(stored.id), JSON.stringify(response)],
    });
    if (used.rowsAffected === 0) {
      throw new ApiRequestError(APPROVAL_INVALID, 410);
    }
    // Grup CS diberi tahu di transaksi yang sama (keputusan P).
    await transaction.execute({
      sql: NOTIFY_CLIENT_RESPONSE_SQL,
      args: [String(stored.id)],
    });
    await writeAudit(
      transaction,
      CLIENT_ACTOR,
      "approval.response",
      "sample",
      String(stored.sample_request_id),
      {
        entity_type: entityType,
        decision: response.decision,
        responder_name: response.responder_name,
        notes: response.notes,
      },
    );
    await transaction.commit();
    return { decision: response.decision };
  } finally {
    transaction.close();
  }
}
