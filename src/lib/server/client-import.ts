import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { companyTimezone, getClientCodeSettings } from "@/lib/server/clients";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { LEAD_INTERACTION_INSERT_SQL } from "@/lib/server/leads";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
} from "@/lib/validations/client";
import {
  DATE_ORDERS,
  type DateOrder,
  IMPORT_MAX_ROWS,
  type ImportContext,
  type ImportRow,
  type ImportRowInput,
  validateImportRow,
} from "@/lib/validations/client-import";

/**
 * Impor CSV (PRD FR-09) — jalur Web. Cermin `plan_import` dan
 * `desktop_import_clients` di `commands.rs`: pratinjau (`dry_run`) dan simpan
 * memakai pemeriksaan yang sama, jadi yang lolos pratinjau adalah yang
 * tersimpan. Lead hasil impor tidak memicu notifikasi (keputusan I).
 */

type Executor = Client | Transaction;

export interface ImportResult {
  line: number;
  status: "skipped" | "invalid";
  message: string;
}

export interface ImportReport {
  dry_run: boolean;
  total: number;
  added: number;
  skipped: number;
  invalid: number;
  results: ImportResult[];
  warnings: { line: number; message: string }[];
}

interface ImportPlan {
  valid: (ImportRow & { pic_cs_id: number })[];
  results: ImportResult[];
  warnings: { line: number; message: string }[];
}

const FIELDS = [
  "client_code",
  "name",
  "phone",
  "address",
  "city",
  "province",
  "needs_notes",
  "channel_option_id",
  "product_category_option_id",
  "lead_created_at",
  "last_update",
  "total_followups",
  "pic_answer",
] as const;

/** Baris dari klien tidak dipercaya: teks selain string dibaca kosong. */
function rowInput(value: unknown): ImportRowInput {
  const source = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const row = Object.fromEntries(
    FIELDS.map((key) => [
      key,
      typeof source[key] === "string" ? source[key] : "",
    ]),
  ) as Omit<ImportRowInput, "line" | "pic_cs_id">;
  return {
    ...row,
    line: Number.isSafeInteger(source.line) ? (source.line as number) : 0,
    pic_cs_id: Number.isSafeInteger(source.pic_cs_id)
      ? (source.pic_cs_id as number)
      : null,
  };
}

function report(
  plan: ImportPlan,
  dryRun: boolean,
  total: number,
): ImportReport {
  return {
    dry_run: dryRun,
    total,
    added: plan.valid.length,
    skipped: plan.results.filter((result) => result.status === "skipped")
      .length,
    invalid: plan.results.filter((result) => result.status === "invalid")
      .length,
    results: plan.results,
    warnings: plan.warnings,
  };
}

async function planImport(
  executor: Executor,
  rows: ImportRowInput[],
  context: ImportContext,
  importerId: number,
  codeSource: { prefix: string; stamp: string; tag: string },
): Promise<ImportPlan> {
  const options = await executor.execute(
    "SELECT id, kind FROM master_option WHERE is_active = 1;",
  );
  const operators = await executor.execute(
    "SELECT id FROM master_operator WHERE COALESCE(status, 'Active') = 'Active';",
  );
  const clients = await executor.execute(
    "SELECT client_code, phone_normalized FROM clients;",
  );
  const activeOptions = new Set(
    options.rows.map((row) => `${String(row.kind)}:${String(row.id)}`),
  );
  const activeOperators = new Set(operators.rows.map((row) => Number(row.id)));
  const existingCodes = clients.rows.map((row) => String(row.client_code));
  // Keunikan tanpa membedakan huruf besar-kecil; urutan dari ejaan asli.
  const codes = new Set(existingCodes.map((code) => code.toLowerCase()));
  const phones = new Map(
    clients.rows.map((row) => [
      String(row.phone_normalized),
      String(row.client_code),
    ]),
  );
  const seenPhones = new Set<string>();
  let nextSequence = nextClientSequence(
    existingCodes,
    codeSource.stamp,
    codeSource.tag,
  );

  const plan: ImportPlan = { valid: [], results: [], warnings: [] };
  for (const input of rows) {
    const reject = (status: ImportResult["status"], message: string) =>
      plan.results.push({ line: input.line, status, message });
    const checked = validateImportRow(input, context);
    if ("error" in checked) {
      reject("invalid", checked.error);
      continue;
    }
    const row = checked.row;
    if (!activeOptions.has(`LEAD_CHANNEL:${row.channel_option_id}`)) {
      reject(
        "invalid",
        "The lead source is not an active Master Data lead channel.",
      );
      continue;
    }
    if (
      !activeOptions.has(`PRODUCT_CATEGORY:${row.product_category_option_id}`)
    ) {
      reject(
        "invalid",
        "The product category is not an active Master Data category.",
      );
      continue;
    }
    const pic = row.pic_cs_id ?? importerId;
    if (!activeOperators.has(pic)) {
      reject("invalid", "The PIC is not an active operator.");
      continue;
    }
    const owner = phones.get(row.phone);
    if (owner !== undefined) {
      reject(
        "skipped",
        `The WhatsApp number ${row.phone} is already registered to client ${owner}.`,
      );
      continue;
    }
    if (seenPhones.has(row.phone)) {
      reject(
        "skipped",
        `The WhatsApp number ${row.phone} appears more than once in this file.`,
      );
      continue;
    }
    let code = row.client_code;
    if (code === "") {
      const generated =
        nextSequence === null
          ? null
          : formatClientCode(
              codeSource.prefix,
              codeSource.stamp,
              codeSource.tag,
              nextSequence,
            );
      if (!generated) {
        reject(
          "invalid",
          "Kode Klien is empty and no new client codes are left for today.",
        );
        continue;
      }
      nextSequence = (nextSequence ?? 0) + 1;
      code = generated;
    } else if (codes.has(code.toLowerCase())) {
      reject(
        "skipped",
        `Kode Klien ${code} already exists or appears more than once in this file.`,
      );
      continue;
    }
    codes.add(code.toLowerCase());
    seenPhones.add(row.phone);
    if (row.note_truncated) {
      plan.warnings.push({
        line: input.line,
        message:
          "Jawaban PIC is longer than 1000 characters and was shortened.",
      });
    }
    plan.valid.push({ ...row, client_code: code, pic_cs_id: pic });
  }
  return plan;
}

export async function importClients(
  client: Client,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<ImportReport> {
  const invalid = (message: string) => new ApiRequestError(message, 400);
  const dryRun = body.dry_run !== false;
  const dateOrder = body.date_order;
  if (
    typeof dateOrder !== "string" ||
    !(DATE_ORDERS as readonly string[]).includes(dateOrder)
  ) {
    throw invalid("Choose the date order used in the sheet.");
  }
  const fileName = [
    ...(typeof body.file_name === "string" ? body.file_name : ""),
  ]
    .slice(0, 200)
    .join("");
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw invalid("The file has no data rows.");
  }
  if (body.rows.length > IMPORT_MAX_ROWS) {
    throw invalid(
      "One import can hold at most 5000 rows. Split the file and import each part.",
    );
  }
  const rows = body.rows.map(rowInput);

  const transaction = await client.transaction(dryRun ? "read" : "write");
  try {
    const clock = await transaction.execute(
      "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch, datetime('now') AS stamp;",
    );
    const now = Number(clock.rows[0]?.epoch);
    const timestamp = String(clock.rows[0]?.stamp);
    const business = await loadBusinessSettings(transaction);
    const timezone = await companyTimezone(transaction);
    const codeSettings = await getClientCodeSettings(transaction);
    const plan = await planImport(
      transaction,
      rows,
      {
        date_order: dateOrder as DateOrder,
        timezone,
        now_epoch: now,
        warm_max_days: business.lead_warm_max_days,
      },
      actor.id,
      {
        prefix: codeSettings.client_code_prefix,
        stamp: companyDateStamp(now, timezone),
        tag: codeSettings.client_code_web_tag,
      },
    );
    if (dryRun || plan.valid.length === 0) {
      return report(plan, dryRun, rows.length);
    }

    for (const row of plan.valid) {
      const id = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      await transaction.execute({
        sql: `INSERT INTO clients
                (id, client_code, name, phone_normalized, address, city, province,
                 lifecycle_status, free_revision_limit, is_white_label, assigned_crm_id,
                 created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'LEAD', ?, 0, NULL, ?, ?, ?);`,
        args: [
          id,
          row.client_code,
          row.name,
          row.phone,
          row.address,
          row.city,
          row.province,
          business.default_free_revision_limit,
          actor.id,
          row.created_at,
          timestamp,
        ],
      });
      await transaction.execute({
        sql: `INSERT INTO leads
                (id, client_id, pic_cs_id, channel_option_id, product_category_option_id,
                 needs_notes, last_followup_at, last_client_response_at, total_followups,
                 created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?);`,
        args: [
          leadId,
          id,
          row.pic_cs_id,
          row.channel_option_id,
          row.product_category_option_id,
          row.needs_notes,
          row.last_client_response_at,
          row.total_followups,
          row.created_at,
          timestamp,
        ],
      });
      if (row.interaction_note) {
        // Keputusan E: INBOUND pada waktu respons terakhir, jadi ringkasan
        // lead (dan Jumlah FU dari sheet) tidak berubah.
        await transaction.execute({
          sql: LEAD_INTERACTION_INSERT_SQL,
          args: [
            crypto.randomUUID(),
            leadId,
            row.pic_cs_id,
            "INBOUND",
            "OTHER",
            row.interaction_note,
            row.last_client_response_at,
            timestamp,
          ],
        });
      }
    }
    const result = report(plan, false, rows.length);
    await writeAudit(transaction, actor, "client.import", "client", "import", {
      file_name: fileName,
      added: result.added,
      skipped: result.skipped,
      invalid: result.invalid,
    });
    await transaction.commit();
    return result;
  } finally {
    transaction.close();
  }
}
