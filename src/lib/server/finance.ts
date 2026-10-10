import "server-only";

import type { Client, Row, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { loadBusinessSettings } from "@/lib/server/business-settings";
import { companyTimezone, getClientCodeSettings } from "@/lib/server/clients";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { attachShipState } from "@/lib/server/production";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
} from "@/lib/validations/client";
import {
  ALLOCATION_INSERT_SQL,
  ALLOCATION_LIST_SQL,
  ALLOCATION_STATE_SQL,
  allocationCheck,
  CANCEL_REASON_INVALID,
  computeInstallments,
  computeInvoice,
  depositError,
  FINANCE_OPTION_UPSERT_SQL,
  FINANCE_OPTIONS_SQL,
  FUND_DEPOSIT_SQL,
  FUND_DEPOSIT_STATE_SQL,
  FUND_INSERT_SQL,
  FUND_LIST_SQL,
  FUND_MEDIA_INSERT_SQL,
  FUND_VOID_SQL,
  INSTALLMENT_INSERT_SQL,
  INVOICE_CANCEL_SQL,
  INVOICE_DESCRIPTION_MAX,
  INVOICE_DUPLICATE,
  INVOICE_DUPLICATE_SQL,
  INVOICE_INSERT_SQL,
  INVOICE_LIST_SQL,
  INVOICE_RESCHEDULE_SQL,
  installmentDescription,
  installmentNumber,
  invoiceDates,
  invoiceRevisionIndex,
  invoiceTypeError,
  normalizeCancelReason,
  partialPaymentError,
  RESCHEDULE_STATE_SQL,
  validateFinanceOption,
  validateFundDraft,
} from "@/lib/validations/finance";
import { validateMediaUpload } from "@/lib/validations/media";
import { NOTIFY_SHIP_CLEARED_SQL } from "@/lib/validations/notification";
import { SAMPLE_LIST_SQL } from "@/lib/validations/sample";

/**
 * Tagihan dan uang masuk — jalur Web (PRD F-17, v2.3a). Cermin command
 * `desktop_*_finance*`, `desktop_*_invoice`, dan `desktop_*_fund` di
 * `commands.rs`; aturan dan SQL-nya bersama (`finance.ts` ↔ `finance.rs`).
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

function text(input: Draft, key: string) {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

async function rows(executor: Executor, sql: string, args: unknown[] = []) {
  const result = await executor.execute({ sql, args: args as never });
  return result.rows.map(plain);
}

async function databaseClock(executor: Executor) {
  const clock = await executor.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch, datetime('now') AS stamp;",
  );
  return {
    epoch: Number(clock.rows[0]?.epoch),
    stamp: String(clock.rows[0]?.stamp),
  };
}

export async function getFinanceOverview(client: Client) {
  const settings = await loadBusinessSettings(client);
  return {
    options: await rows(client, FINANCE_OPTIONS_SQL),
    invoices: await rows(
      client,
      `${INVOICE_LIST_SQL} ORDER BY i.created_at DESC, i.id;`,
    ),
    funds: await rows(
      client,
      `${FUND_LIST_SQL} ORDER BY f.received_on DESC, f.created_at DESC, f.id;`,
    ),
    allocations: await rows(client, ALLOCATION_LIST_SQL),
    defaults: {
      default_sample_fee_idr: settings.default_sample_fee_idr,
      default_test_fee_idr: settings.default_test_fee_idr,
      default_dummy_fee_idr: settings.default_dummy_fee_idr,
      invoice_due_days: settings.invoice_due_days,
      invoice_payment_instructions: settings.invoice_payment_instructions,
    },
  };
}

/** Cermin `desktop_save_finance_option`. */
export async function saveFinanceOption(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const requestedId = text(input, "id");
  const transaction = await client.transaction("write");
  try {
    let id = requestedId;
    let sortOrder: number;
    const candidate: Draft = { ...input };
    if (!requestedId) {
      const next = await transaction.execute({
        sql: "SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM finance_options WHERE kind = ?;",
        args: [text(input, "kind")],
      });
      id = crypto.randomUUID();
      sortOrder = Number(next.rows[0]?.next ?? 10);
    } else {
      const found = await transaction.execute({
        sql: "SELECT kind, sort_order FROM finance_options WHERE id = ?;",
        args: [requestedId],
      });
      const row = found.rows[0];
      if (!row) throw new ApiRequestError("Option not found.", 404);
      candidate.kind = String(row.kind);
      sortOrder = Number(row.sort_order);
    }
    const checked = validateFinanceOption(candidate);
    if ("error" in checked) invalid(checked.error);
    const { stamp } = await databaseClock(transaction);
    await transaction.execute({
      sql: FINANCE_OPTION_UPSERT_SQL,
      args: [
        id,
        checked.option.kind,
        checked.option.label,
        checked.option.rate_bp,
        checked.option.is_active ? 1 : 0,
        sortOrder,
        stamp,
        checked.option.installment_count,
      ],
    });
    await writeAudit(
      transaction,
      actor,
      "finance_option.save",
      "finance_option",
      id,
      { ...checked.option },
    );
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/** `{ label, rate_bp }` untuk pajak/diskon aktif; null = tidak sah. */
async function activeRate(executor: Executor, id: string, kind: string) {
  const result = await executor.execute({
    sql: "SELECT label, rate_bp FROM finance_options WHERE id = ? AND kind = ? AND is_active = 1;",
    args: [id, kind],
  });
  const row = result.rows[0];
  return row
    ? { label: String(row.label), rate_bp: Number(row.rate_bp) }
    : null;
}

/** Cermin `desktop_create_invoice`; nomor memakai tag Web. */
export async function createInvoice(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const refType = text(input, "ref_type");
  const sampleId = text(input, "sample_request_id");
  const description = text(input, "description");
  if ([...description].length > INVOICE_DESCRIPTION_MAX) {
    invalid("The description is up to 300 characters.");
  }
  const transaction = await client.transaction("write");
  try {
    let ticket: Record<string, unknown> | null = null;
    if (sampleId) {
      const found = await rows(
        transaction,
        `${SAMPLE_LIST_SQL} WHERE s.id = ?;`,
        [sampleId],
      );
      ticket = found[0] ?? null;
      if (!ticket) throw new ApiRequestError("Sample request not found.", 404);
      // Pelunasan dan biaya titip (v3.3) membaca work order tiket ini.
      [ticket] = await attachShipState(transaction, [ticket]);
    }
    const typeError = invoiceTypeError(
      refType,
      ticket
        ? {
            is_paid_sample: Number(ticket.is_paid_sample) === 1,
            is_test_requested: Number(ticket.is_test_requested) === 1,
            revision_fee_idr:
              ticket.revision_fee_idr == null
                ? null
                : Number(ticket.revision_fee_idr),
            dummy_round:
              ticket.dummy_round == null ? null : Number(ticket.dummy_round),
            mou_accepted: ticket.mou_status === "ACCEPTED",
            batch_packed: Number(ticket.batch_stages ?? 0) >= 4,
            settlement_cleared: Number(ticket.settlement_cleared ?? 0) === 1,
            storage_fee_idr: Number(ticket.storage_fee_idr ?? 0),
          }
        : null,
    );
    if (typeError) invalid(typeError);
    const clientId = ticket
      ? String(ticket.client_id)
      : text(input, "client_id");
    const owner = await rows(
      transaction,
      "SELECT client_code FROM clients WHERE id = ?;",
      [clientId],
    );
    if (!owner[0]) throw new ApiRequestError("Client not found.", 404);
    const revisionIndex = ticket
      ? invoiceRevisionIndex(
          refType,
          Number(ticket.revision_index),
          ticket.dummy_round == null ? null : Number(ticket.dummy_round),
        )
      : 0;
    if (ticket && refType !== "OTHER") {
      const duplicates = await rows(transaction, INVOICE_DUPLICATE_SQL, [
        sampleId,
        refType,
        revisionIndex,
        "",
      ]);
      if (Number(duplicates[0]?.total) > 0) invalid(INVOICE_DUPLICATE);
    }
    const discountId = text(input, "discount_option_id");
    const discount = discountId
      ? await activeRate(transaction, discountId, "DISCOUNT")
      : null;
    if (discountId && !discount) invalid("Choose an active discount.");
    const taxes: { label: string; rate_bp: number }[] = [];
    const taxIds = Array.isArray(input.tax_option_ids)
      ? input.tax_option_ids
      : [];
    for (const taxId of taxIds) {
      const tax = await activeRate(transaction, String(taxId), "TAX");
      if (!tax) invalid("Choose active taxes only.");
      taxes.push(tax);
    }
    const rates = { subtotal_idr: input.subtotal_idr, discount, taxes };
    const computed = computeInvoice(rates);
    if ("error" in computed) invalid(computed.error);
    const totals = computed.totals;

    const { epoch, stamp } = await databaseClock(transaction);
    const timezone = await companyTimezone(transaction);
    const codes = await getClientCodeSettings(transaction);
    const tag = codes.client_code_web_tag;
    const dateStamp = companyDateStamp(epoch, timezone);
    const existing = await rows(
      transaction,
      "SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?;",
      [`%-${dateStamp}-${tag}__`],
    );
    const sequence = nextClientSequence(
      existing.map((row) => String(row.invoice_number)),
      dateStamp,
      tag,
    );
    const number =
      sequence == null
        ? null
        : formatClientCode(
            codes.invoice_number_prefix,
            dateStamp,
            tag,
            sequence,
          );
    if (!number) {
      throw new ApiRequestError(
        "The Web has used up its invoice numbers for today.",
        409,
      );
    }
    const settings = await loadBusinessSettings(transaction);
    const dates = invoiceDates(epoch, timezone, settings.invoice_due_days);
    const id = crypto.randomUUID();
    await transaction.execute({
      sql: INVOICE_INSERT_SQL,
      args: [
        id,
        number,
        clientId,
        sampleId,
        refType,
        revisionIndex,
        description,
        totals.subtotal_idr,
        totals.discount_label,
        totals.discount_bp,
        totals.discount_idr,
        totals.taxes_json,
        totals.tax_idr,
        totals.total_idr,
        dates.issued_on,
        dates.due_on,
        actor.id,
        stamp,
      ],
    });
    await writeAudit(transaction, actor, "invoice.create", "invoice", id, {
      invoice_number: number,
      client_code: String(owner[0].client_code),
      ref_type: refType,
      total_idr: totals.total_idr,
    });
    // Tagihan biaya titip yang dibebaskan (total 0) langsung lunas (v3.3).
    await transaction.execute({ sql: NOTIFY_SHIP_CLEARED_SQL, args: [id] });
    await transaction.commit();
    return { id, invoice_number: number, total_idr: totals.total_idr };
  } finally {
    transaction.close();
  }
}

async function cancelRecord(
  client: Client,
  input: Draft,
  actor: AuditActor,
  kind: "invoice" | "fund",
) {
  const id = text(input, "id");
  const reason = normalizeCancelReason(input.reason);
  if (!reason) invalid(CANCEL_REASON_INVALID);
  const transaction = await client.transaction("write");
  try {
    const { stamp } = await databaseClock(transaction);
    const changed = await transaction.execute({
      sql: kind === "invoice" ? INVOICE_CANCEL_SQL : FUND_VOID_SQL,
      args: [id, reason, stamp],
    });
    if (changed.rowsAffected === 0) {
      invalid(
        kind === "invoice"
          ? "Only an open invoice with no payment can be cancelled."
          : "Only an incoming payment with nothing allocated can be voided.",
      );
    }
    await writeAudit(
      transaction,
      actor,
      kind === "invoice" ? "invoice.cancel" : "fund.void",
      kind,
      id,
      { reason },
    );
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/** Cermin `desktop_cancel_invoice` (keputusan N). */
export function cancelInvoice(client: Client, input: Draft, actor: AuditActor) {
  return cancelRecord(client, input, actor, "invoice");
}

/** Cermin `desktop_void_incoming_fund`. */
export function voidIncomingFund(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  return cancelRecord(client, input, actor, "fund");
}

/** Cermin `desktop_record_incoming_fund` (keputusan F). */
export async function recordIncomingFund(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const checked = validateFundDraft(input);
  if ("error" in checked) invalid(checked.error);
  const fund = checked.fund;
  const proof = text(input, "proof_base64");
  let proofSize: number | null = null;
  if (proof) {
    const media = validateMediaUpload("PAYMENT_PROOF", proof);
    if ("error" in media) invalid(media.error);
    proofSize = media.byte_size;
  }
  const transaction = await client.transaction("write");
  try {
    if (fund.client_id) {
      const owner = await rows(
        transaction,
        "SELECT id FROM clients WHERE id = ?;",
        [fund.client_id],
      );
      if (!owner[0]) throw new ApiRequestError("Client not found.", 404);
    }
    const { stamp } = await databaseClock(transaction);
    const id = crypto.randomUUID();
    const proofId = proofSize === null ? "" : crypto.randomUUID();
    if (proofSize !== null) {
      await transaction.execute({
        sql: FUND_MEDIA_INSERT_SQL,
        args: [proofId, id, proofSize, proof, actor.id, stamp],
      });
    }
    await transaction.execute({
      sql: FUND_INSERT_SQL,
      args: [
        id,
        fund.client_id,
        fund.received_on,
        fund.amount_idr,
        fund.description,
        proofId,
        actor.id,
        stamp,
      ],
    });
    await writeAudit(transaction, actor, "fund.record", "fund", id, {
      received_on: fund.received_on,
      amount_idr: fund.amount_idr,
      has_proof: proofSize !== null,
    });
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/** Cermin `desktop_allocate_fund` (keputusan G: persis sebesar sisanya). */
export async function allocateFund(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const fundId = text(input, "fund_id");
  const invoiceId = text(input, "invoice_id");
  const transaction = await client.transaction("write");
  try {
    const state = await rows(transaction, ALLOCATION_STATE_SQL, [
      invoiceId,
      fundId,
    ]);
    const problem = allocationCheck(state[0], input.amount_idr);
    if (problem) invalid(problem);
    const amount = Number(input.amount_idr);
    const invoice = await rows(
      transaction,
      "SELECT invoice_number FROM invoices WHERE id = ?;",
      [invoiceId],
    );
    const { stamp } = await databaseClock(transaction);
    const id = crypto.randomUUID();
    await transaction.execute({
      sql: ALLOCATION_INSERT_SQL,
      args: [id, fundId, invoiceId, amount, actor.id, stamp],
    });
    // Pelunasan lunas: Logistik boleh mengirim (v3.3, keputusan H).
    await transaction.execute({
      sql: NOTIFY_SHIP_CLEARED_SQL,
      args: [invoiceId],
    });
    await writeAudit(
      transaction,
      actor,
      "fund.allocate",
      "invoice",
      invoiceId,
      {
        invoice_number: String(invoice[0]?.invoice_number ?? ""),
        amount_idr: amount,
      },
    );
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

/**
 * Terima pembayaran sebagian (v2.3b, D-29): alokasi + jadwal ulang sisanya
 * menjadi tagihan cicilan, satu transaksi. Izin `payments.approve_exception`
 * diperiksa route. Cermin `desktop_accept_partial_payment`.
 */
export async function acceptPartialPayment(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const fundId = text(input, "fund_id");
  const invoiceId = text(input, "invoice_id");
  const planId = text(input, "plan_option_id");
  const transaction = await client.transaction("write");
  try {
    const row = (
      await rows(transaction, RESCHEDULE_STATE_SQL, [invoiceId, fundId])
    )[0];
    if (!row) throw new ApiRequestError("Invoice not found.", 404);
    if (row.status !== "OPEN") {
      invalid("This invoice is cancelled or already settled.");
    }
    if (row.fund_status !== "ACTIVE") {
      invalid("This incoming payment is void or does not exist.");
    }
    const remaining = Number(row.invoice_remaining ?? 0);
    const problem = partialPaymentError(
      input.amount_idr,
      String(row.ref_type),
      remaining,
      Number(row.fund_unallocated ?? 0),
    );
    if (problem) invalid(problem);
    const plan = (
      await rows(
        transaction,
        "SELECT label, rate_bp, installment_count FROM finance_options WHERE id = ? AND kind = 'INSTALLMENT_PLAN' AND is_active = 1;",
        [planId],
      )
    )[0];
    const count = Number(plan?.installment_count ?? 0);
    if (!plan || count < 1) invalid("Choose an active installment plan.");
    const amount = Number(input.amount_idr);
    const remainingAfter = remaining - amount;
    const { epoch, stamp } = await databaseClock(transaction);
    const startOn = invoiceDates(
      epoch,
      await companyTimezone(transaction),
      0,
    ).issued_on;
    const schedule = computeInstallments(
      remainingAfter,
      Number(plan.rate_bp),
      count,
      startOn,
    );
    const parentNumber = String(row.invoice_number);
    const label = String(plan.label);
    await transaction.execute({
      sql: ALLOCATION_INSERT_SQL,
      args: [crypto.randomUUID(), fundId, invoiceId, amount, actor.id, stamp],
    });
    const changed = await transaction.execute({
      sql: INVOICE_RESCHEDULE_SQL,
      args: [invoiceId, stamp],
    });
    if (changed.rowsAffected === 0) {
      invalid("This invoice is cancelled or already settled.");
    }
    for (const line of schedule.lines) {
      await transaction.execute({
        sql: INSTALLMENT_INSERT_SQL,
        args: [
          crypto.randomUUID(),
          installmentNumber(parentNumber, line.installment_no),
          String(row.client_id),
          String(row.sample_request_id),
          Number(row.revision_index),
          installmentDescription(
            line.installment_no,
            count,
            parentNumber,
            label,
          ),
          line.amount_idr,
          startOn,
          line.due_on,
          invoiceId,
          line.installment_no,
          actor.id,
          stamp,
        ],
      });
    }
    await writeAudit(
      transaction,
      actor,
      "invoice.reschedule",
      "invoice",
      invoiceId,
      {
        invoice_number: parentNumber,
        amount_idr: amount,
        remaining_idr: remainingAfter,
        plan: label,
        interest_idr: schedule.interest_idr,
        total_idr: schedule.total_idr,
        installments: count,
      },
    );
    await transaction.commit();
    return {
      id: invoiceId,
      installments: count,
      total_idr: schedule.total_idr,
    };
  } finally {
    transaction.close();
  }
}

/** Sisa uang masuk sebagai deposit klien (keputusan I). Cermin `desktop_confirm_deposit`. */
export async function confirmDeposit(
  client: Client,
  input: Draft,
  actor: AuditActor,
) {
  const fundId = text(input, "fund_id");
  const transaction = await client.transaction("write");
  try {
    const row = (await rows(transaction, FUND_DEPOSIT_STATE_SQL, [fundId]))[0];
    const recorded = String(row?.client_id ?? "");
    // Klien yang sudah tercatat di uang masuk tidak bisa diganti di sini.
    const clientId = recorded || text(input, "client_id");
    const unallocated = Number(row?.unallocated ?? 0);
    const problem = depositError(
      row?.status,
      row?.deposit_confirmed_at,
      clientId,
      unallocated,
    );
    if (problem) invalid(problem);
    const owner = await rows(
      transaction,
      "SELECT client_code FROM clients WHERE id = ?;",
      [clientId],
    );
    if (!owner[0]) throw new ApiRequestError("Client not found.", 404);
    const { stamp } = await databaseClock(transaction);
    const changed = await transaction.execute({
      sql: FUND_DEPOSIT_SQL,
      args: [fundId, clientId, actor.id, stamp],
    });
    if (changed.rowsAffected === 0) {
      invalid("This payment is already kept as a deposit.");
    }
    await writeAudit(transaction, actor, "fund.deposit", "fund", fundId, {
      client_code: String(owner[0].client_code),
      amount_idr: unallocated,
    });
    await transaction.commit();
    return { id: fundId };
  } finally {
    transaction.close();
  }
}
