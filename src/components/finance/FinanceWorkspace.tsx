"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ExportButton } from "@/components/imports/ExportButton";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { excelDay } from "@/lib/documents/xlsx";
import { type ClientRecord, listClients } from "@/lib/gateways/clients";
import {
  allocateFund,
  cancelInvoice,
  confirmDeposit,
  type FinanceOverview,
  type FundRecord,
  getFinanceOverview,
  type InvoiceRecord,
  voidIncomingFund,
} from "@/lib/gateways/finance";
import {
  getMediaDataUrl,
  listSampleRequests,
  type SampleRequestRecord,
} from "@/lib/gateways/samples";
import {
  requestSyncNow,
  SYNC_COMPLETED_EVENT,
} from "@/lib/gateways/sync-status";
import { allocationError, CANCEL_REASON_MAX } from "@/lib/validations/finance";
import { formatRupiah } from "@/lib/validations/sample";
import { FundForm } from "./FundForm";
import { InvoiceForm } from "./InvoiceForm";
import { downloadInvoicePdf } from "./invoice-download";
import {
  FUND_FILTERS,
  type FundFilter,
  INVOICE_FILTERS,
  INVOICE_TYPE_LABEL,
  type InvoiceFilter,
  invoiceStatusLabel,
  invoiceTone,
  isOverdue,
  localToday,
  matchesFundFilter,
  matchesInvoiceFilter,
  matchesSearch,
} from "./labels";

/** Baris pertama yang dirender; sisanya lewat "Show more". */
const PAGE_SIZE = 100;

import { PartialPaymentForm } from "./PartialPaymentForm";

/**
 * Halaman Finance (PRD F-17, v2.3a): tagihan dan uang masuk. Ditulis sekali
 * untuk Web-Desktop dan Mobile (`filesToCopy`). `?sample=<id>` membuka form
 * tagihan untuk tiket itu (tombol dari detail tiket).
 */

type Tab = "invoices" | "funds";

/** Pembatalan tagihan atau uang masuk, alasan wajib (keputusan N). */
interface CancelTarget {
  kind: "invoice" | "fund";
  id: string;
  label: string;
}

export function FinanceWorkspace() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "finance.manage");
  // Pembayaran sebagian dan deposit (v2.3b, keputusan A dan I).
  const canApprove = hasPermission(user, "payments.approve_exception");
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [samples, setSamples] = useState<SampleRequestRecord[]>([]);
  const [tab, setTab] = useState<Tab>("invoices");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invoiceForm, setInvoiceForm] = useState<{ sampleId: string } | null>(
    null,
  );
  const [fundForm, setFundForm] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [reason, setReason] = useState("");
  const [allocating, setAllocating] = useState<FundRecord | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [partialFund, setPartialFund] = useState<FundRecord | null>(null);
  const [depositFund, setDepositFund] = useState<FundRecord | null>(null);
  const [depositClient, setDepositClient] = useState("");
  const [busy, setBusy] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("UNPAID");
  const [fundFilter, setFundFilter] = useState<FundFilter>("UNALLOCATED");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setOverview(await getFinanceOverview());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Finance could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Pilihan form: gagal dibaca = form menampilkan daftar kosong.
    void listClients()
      .then(setClients)
      .catch(() => setClients([]));
    void listSampleRequests()
      .then((list) => setSamples(list.requests))
      .catch(() => setSamples([]));
    const requested = new URLSearchParams(window.location.search).get("sample");
    if (requested && canManage) setInvoiceForm({ sampleId: requested });
    const onSync = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSync);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSync);
  }, [refresh, canManage]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      setNotice(done);
      setCancelTarget(null);
      setReason("");
      setAllocating(null);
      setInvoiceId("");
      setDepositFund(null);
      setDepositClient("");
      requestSyncNow();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing was saved.");
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  // Hanya membaca dan menyimpan berkas: tanpa sync dan tanpa muat ulang.
  const exportPdf = async (invoice: InvoiceRecord) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      setNotice(await downloadInvoicePdf(invoice));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PDF was not created.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const submitCancel = (event: FormEvent) => {
    event.preventDefault();
    if (!cancelTarget) return;
    void run(
      () =>
        cancelTarget.kind === "invoice"
          ? cancelInvoice(cancelTarget.id, reason)
          : voidIncomingFund(cancelTarget.id, reason),
      cancelTarget.kind === "invoice"
        ? "Invoice cancelled."
        : "Incoming payment voided.",
    );
  };

  const openInvoices = (overview?.invoices ?? []).filter(
    (invoice) =>
      invoice.status === "OPEN" && invoice.paid_idr < invoice.total_idr,
  );
  const chosen = openInvoices.find((invoice) => invoice.id === invoiceId);
  const remaining = chosen ? chosen.total_idr - chosen.paid_idr : 0;
  const unallocated = allocating
    ? allocating.amount_idr - allocating.allocated_idr
    : 0;
  const allocationProblem = chosen
    ? allocationError(remaining, remaining, unallocated)
    : "Choose the invoice this payment settles.";

  const today = localToday();
  const plans = (overview?.options ?? []).filter(
    (option) => option.kind === "INSTALLMENT_PLAN" && option.is_active === 1,
  );
  // Saldo deposit per klien: sisa uang masuk yang dikonfirmasi sebagai deposit.
  const deposits = new Map<string, { label: string; amount: number }>();
  for (const fund of overview?.funds ?? []) {
    const left = fund.amount_idr - fund.allocated_idr;
    if (fund.status !== "ACTIVE" || !fund.deposit_confirmed_at || left < 1)
      continue;
    const entry = deposits.get(fund.client_id) ?? {
      label: `${fund.client_code} · ${fund.client_name}`,
      amount: 0,
    };
    entry.amount += left;
    deposits.set(fund.client_id, entry);
  }

  const showProof = async (mediaId: string) => {
    try {
      window.open(await getMediaDataUrl(mediaId), "_blank", "noopener");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The proof photo could not be opened.",
      );
    }
  };

  const invoiceRow = (invoice: InvoiceRecord) => (
    <li
      key={invoice.id}
      className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-body-md font-semibold text-on-surface">
            {invoice.invoice_number}
          </span>
          <StatusBadge tone={invoiceTone(invoice)}>
            {invoiceStatusLabel(invoice)}
          </StatusBadge>
          {isOverdue(invoice, today) ? (
            <StatusBadge tone="danger">Overdue</StatusBadge>
          ) : null}
        </span>
        <span className="block text-body-sm text-on-surface-variant">
          {invoice.client_code} · {invoice.client_name} ·{" "}
          {INVOICE_TYPE_LABEL[invoice.ref_type] ?? invoice.ref_type}
          {invoice.brand_name ? ` · ${invoice.brand_name}` : ""}
        </span>
        {invoice.status === "CANCELLED" ? (
          <span className="block text-body-sm text-on-surface-variant">
            Cancelled: {invoice.cancel_reason}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
        <span className="text-body-sm text-on-surface-variant sm:text-right">
          <span className="block text-body-md font-semibold text-on-surface">
            {formatRupiah(invoice.total_idr)}
          </span>
          <span className="block">Due {invoice.due_on}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportPdf(invoice)}
          className="app-btn app-btn-secondary"
        >
          PDF
        </button>
        {canManage && invoice.status === "OPEN" && invoice.paid_idr === 0 ? (
          <button
            type="button"
            onClick={() =>
              setCancelTarget({
                kind: "invoice",
                id: invoice.id,
                label: invoice.invoice_number,
              })
            }
            className="app-btn app-btn-secondary"
          >
            Cancel
          </button>
        ) : null}
      </span>
    </li>
  );

  const fundRow = (fund: FundRecord) => {
    const left = fund.amount_idr - fund.allocated_idr;
    return (
      <li
        key={fund.id}
        className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-body-md font-semibold text-on-surface">
              {formatRupiah(fund.amount_idr)}
            </span>
            <StatusBadge
              tone={
                fund.status === "VOID"
                  ? "neutral"
                  : left > 0
                    ? "warning"
                    : "success"
              }
            >
              {fund.status === "VOID"
                ? "Void"
                : left > 0
                  ? `${formatRupiah(left)} unallocated`
                  : "Fully allocated"}
            </StatusBadge>
          </span>
          <span className="block text-body-sm text-on-surface-variant">
            {fund.received_on}
            {fund.client_code
              ? ` · ${fund.client_code} · ${fund.client_name}`
              : " · Client not known yet"}
            {fund.description ? ` · ${fund.description}` : ""}
          </span>
          {fund.status === "VOID" ? (
            <span className="block text-body-sm text-on-surface-variant">
              Voided: {fund.void_reason}
            </span>
          ) : null}
          {fund.deposit_confirmed_at && left > 0 ? (
            <span className="block text-body-sm text-on-surface-variant">
              Kept as the client's deposit
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-wrap gap-2">
          {fund.proof_media_id ? (
            <button
              type="button"
              onClick={() => void showProof(fund.proof_media_id)}
              className="app-btn app-btn-secondary"
            >
              Proof
            </button>
          ) : null}
          {canManage && fund.status === "ACTIVE" && left > 0 ? (
            <button
              type="button"
              onClick={() => {
                setAllocating(fund);
                setInvoiceId("");
              }}
              className="app-btn app-btn-primary"
            >
              Allocate
            </button>
          ) : null}
          {canApprove && fund.status === "ACTIVE" && left > 0 ? (
            <button
              type="button"
              onClick={() => setPartialFund(fund)}
              className="app-btn app-btn-secondary"
            >
              Accept partial payment
            </button>
          ) : null}
          {canApprove &&
          fund.status === "ACTIVE" &&
          left > 0 &&
          !fund.deposit_confirmed_at ? (
            <button
              type="button"
              onClick={() => {
                setDepositFund(fund);
                setDepositClient(fund.client_id);
              }}
              className="app-btn app-btn-secondary"
            >
              Keep as deposit
            </button>
          ) : null}
          {canManage && fund.status === "ACTIVE" && fund.allocated_idr === 0 ? (
            <button
              type="button"
              onClick={() =>
                setCancelTarget({
                  kind: "fund",
                  id: fund.id,
                  label: `${formatRupiah(fund.amount_idr)} on ${fund.received_on}`,
                })
              }
              className="app-btn app-btn-secondary"
            >
              Void
            </button>
          ) : null}
        </span>
      </li>
    );
  };

  const term = search.trim();
  const searchedInvoices = (overview?.invoices ?? []).filter((invoice) =>
    matchesSearch(term, [
      invoice.invoice_number,
      invoice.client_code,
      invoice.client_name,
      invoice.brand_name,
      invoice.description,
    ]),
  );
  const searchedFunds = (overview?.funds ?? []).filter((fund) =>
    matchesSearch(term, [
      fund.received_on,
      fund.description,
      fund.client_code,
      fund.client_name,
    ]),
  );
  const invoices = searchedInvoices.filter((invoice) =>
    matchesInvoiceFilter(invoiceFilter, invoice, today),
  );
  const funds = searchedFunds.filter((fund) =>
    matchesFundFilter(fundFilter, fund),
  );
  const filters =
    tab === "invoices"
      ? INVOICE_FILTERS.map(([value, label]) => ({
          value,
          label,
          count: searchedInvoices.filter((invoice) =>
            matchesInvoiceFilter(value, invoice, today),
          ).length,
        }))
      : FUND_FILTERS.map(([value, label]) => ({
          value,
          label,
          count: searchedFunds.filter((fund) => matchesFundFilter(value, fund))
            .length,
        }));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const outstanding = sum(
    (overview?.invoices ?? [])
      .filter((invoice) => matchesInvoiceFilter("UNPAID", invoice, today))
      .map((invoice) => invoice.total_idr - invoice.paid_idr),
  );
  const overdue = sum(
    (overview?.invoices ?? [])
      .filter((invoice) => isOverdue(invoice, today))
      .map((invoice) => invoice.total_idr - invoice.paid_idr),
  );
  const unallocatedTotal = sum(
    (overview?.funds ?? [])
      .filter((fund) => matchesFundFilter("UNALLOCATED", fund))
      .map((fund) => fund.amount_idr - fund.allocated_idr),
  );
  const rows = tab === "invoices" ? invoices.length : funds.length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Finance"
        description="Invoices and the payments that settle them. An invoice is paid once incoming payments are allocated to its full total."
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setInvoiceForm({ sampleId: "" })}
                className="app-btn app-btn-primary"
              >
                New invoice
              </button>
              <button
                type="button"
                onClick={() => setFundForm(true)}
                className="app-btn app-btn-secondary"
              >
                Record payment
              </button>
              {/* Data Uang Masuk lama (v2.7, PRD F-22). */}
              <Link href="/import" className="app-btn app-btn-secondary">
                Import CSV
              </Link>
            </div>
          ) : null
        }
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}
      {notice ? (
        <FeedbackBanner tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </FeedbackBanner>
      ) : null}

      <div
        role="tablist"
        aria-label="Finance views"
        className="flex gap-1 border-b border-surface-container"
      >
        {(
          [
            ["invoices", "Invoices"],
            ["funds", "Incoming payments"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setShown(PAGE_SIZE);
            }}
            className={`-mb-px min-h-11 border-b-2 px-3 text-body-md font-semibold ${
              tab === value
                ? "border-primary text-on-surface"
                : "border-transparent text-on-surface-variant"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "funds" && deposits.size > 0 ? (
        <section aria-label="Client deposits" className="app-panel p-4">
          <h2 className="text-body-md font-semibold text-on-surface">
            Client deposits
          </h2>
          <ul className="mt-2 grid gap-1 text-body-md text-on-surface">
            {[...deposits.values()].map((entry) => (
              <li key={entry.label}>
                {entry.label}: {formatRupiah(entry.amount)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-body-sm text-on-surface-variant">
            Use Allocate on the payment to spend a deposit on one of the
            client's invoices.
          </p>
        </section>
      ) : null}

      {overview ? (
        <section
          aria-label="Totals"
          className="flex flex-wrap gap-x-6 gap-y-1 text-body-md text-on-surface"
        >
          {tab === "invoices" ? (
            <>
              <span>
                Outstanding:{" "}
                <span className="font-semibold">
                  {formatRupiah(outstanding)}
                </span>
              </span>
              <span>
                Overdue:{" "}
                <span className="font-semibold text-error">
                  {formatRupiah(overdue)}
                </span>
              </span>
            </>
          ) : (
            <span>
              Unallocated:{" "}
              <span className="font-semibold">
                {formatRupiah(unallocatedTotal)}
              </span>
            </span>
          )}
        </section>
      ) : null}

      <div className="grid gap-3">
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setShown(PAGE_SIZE);
          }}
          placeholder={
            tab === "invoices"
              ? "Search invoice number, client, or brand"
              : "Search date, description, or client"
          }
          aria-label="Search"
          className="app-input"
        />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Filter by status</legend>
          {filters.map((filter) => {
            const active =
              (tab === "invoices" ? invoiceFilter : fundFilter) ===
              filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (tab === "invoices")
                    setInvoiceFilter(filter.value as InvoiceFilter);
                  else setFundFilter(filter.value as FundFilter);
                  setShown(PAGE_SIZE);
                }}
                className={`app-btn ${active ? "app-btn-primary" : "app-btn-secondary"}`}
              >
                {filter.label} ({filter.count})
              </button>
            );
          })}
        </fieldset>
      </div>

      {tab === "invoices" ? (
        <ExportButton
          subject="invoices"
          rows={() => [
            [
              "Invoice number",
              "Issued on",
              "Due on",
              "Client code",
              "Client",
              "Brand",
              "For",
              "Total (IDR)",
              "Paid (IDR)",
              "Remaining (IDR)",
              "Status",
            ],
            ...invoices.map((invoice) => [
              invoice.invoice_number,
              excelDay(invoice.issued_on),
              excelDay(invoice.due_on),
              invoice.client_code,
              invoice.client_name,
              invoice.brand_name,
              INVOICE_TYPE_LABEL[invoice.ref_type] ?? invoice.ref_type,
              invoice.total_idr,
              invoice.paid_idr,
              Math.max(0, invoice.total_idr - invoice.paid_idr),
              invoiceStatusLabel(invoice),
            ]),
          ]}
        />
      ) : (
        // Empat kolom pertama = kolom impor Data Uang Masuk (v2.8).
        <ExportButton
          subject="funds"
          rows={() => [
            [
              "Tanggal",
              "Nominal",
              "Keterangan",
              "Kode Klien",
              "Allocated (IDR)",
              "Status",
            ],
            ...funds.map((fund) => [
              excelDay(fund.received_on),
              fund.amount_idr,
              fund.description,
              fund.client_code,
              fund.allocated_idr,
              FUND_FILTERS.find(
                ([value]) => value !== "ALL" && matchesFundFilter(value, fund),
              )?.[1] ?? fund.status,
            ]),
          ]}
        />
      )}

      <section className="app-panel overflow-hidden">
        {!overview ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : rows === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            {term
              ? "Nothing matches this search."
              : tab === "invoices"
                ? "No invoices in this view."
                : "No incoming payments in this view."}
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {tab === "invoices"
              ? invoices.slice(0, shown).map(invoiceRow)
              : funds.slice(0, shown).map(fundRow)}
          </ul>
        )}
      </section>
      {rows > shown ? (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE_SIZE)}
          className="app-btn app-btn-secondary w-full"
        >
          Show more ({rows - shown} left)
        </button>
      ) : null}

      {partialFund ? (
        <PartialPaymentForm
          fund={partialFund}
          invoices={openInvoices}
          plans={plans}
          onSaved={(message) => {
            setPartialFund(null);
            setNotice(message);
            void refresh();
          }}
          onClose={() => setPartialFund(null)}
        />
      ) : null}

      {depositFund ? (
        <Modal
          title={`Keep ${formatRupiah(depositFund.amount_idr - depositFund.allocated_idr)} as a deposit`}
          titleId="finance-deposit-title"
          onClose={() => setDepositFund(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () => confirmDeposit(depositFund.id, depositClient),
                "Kept as the client's deposit.",
              );
            }}
            className="grid gap-3"
          >
            <p className="text-body-sm text-on-surface-variant">
              The rest of this payment stays with the client and can be
              allocated to their invoices later.
            </p>
            {depositFund.client_id ? (
              <p className="text-body-md text-on-surface">
                Client: {depositFund.client_code} · {depositFund.client_name}
              </p>
            ) : (
              <label className="app-label grid gap-1.5">
                Client
                <select
                  required
                  value={depositClient}
                  onChange={(event) => setDepositClient(event.target.value)}
                  className="app-input font-normal"
                >
                  <option value="">Choose…</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.client_code} · {client.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="app-btn app-btn-primary"
              >
                {busy ? "Saving…" : "Keep as deposit"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDepositFund(null)}
                className="app-btn app-btn-secondary"
              >
                Back
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {invoiceForm && overview ? (
        <InvoiceForm
          overview={overview}
          clients={clients}
          samples={samples}
          initialSampleId={invoiceForm.sampleId}
          onSaved={(number) => {
            setInvoiceForm(null);
            setNotice(`Invoice ${number} created.`);
            void refresh();
          }}
          onClose={() => setInvoiceForm(null)}
        />
      ) : null}

      {fundForm ? (
        <FundForm
          clients={clients}
          onSaved={() => {
            setFundForm(false);
            setNotice("Incoming payment recorded.");
            setTab("funds");
            void refresh();
          }}
          onClose={() => setFundForm(false)}
        />
      ) : null}

      {cancelTarget ? (
        <Modal
          title={
            cancelTarget.kind === "invoice"
              ? `Cancel invoice ${cancelTarget.label}`
              : `Void payment ${cancelTarget.label}`
          }
          titleId="finance-cancel-title"
          onClose={() => setCancelTarget(null)}
        >
          <form onSubmit={submitCancel} className="grid gap-3">
            <label className="app-label grid gap-1.5">
              Reason
              <textarea
                required
                rows={3}
                maxLength={CANCEL_REASON_MAX}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="app-input min-h-20 py-2 font-normal"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="app-btn app-btn-danger"
              >
                {busy ? "Saving…" : "Confirm"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setCancelTarget(null)}
                className="app-btn app-btn-secondary"
              >
                Back
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {allocating ? (
        <Modal
          title={`Allocate ${formatRupiah(unallocated)}`}
          titleId="finance-allocate-title"
          onClose={() => setAllocating(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!chosen) return;
              void run(
                () => allocateFund(allocating.id, chosen.id, remaining),
                `Invoice ${chosen.invoice_number} is paid.`,
              );
            }}
            className="grid gap-3"
          >
            <label className="app-label grid gap-1.5">
              Invoice
              <select
                required
                value={invoiceId}
                onChange={(event) => setInvoiceId(event.target.value)}
                className="app-input font-normal"
              >
                <option value="">Choose…</option>
                {openInvoices
                  .filter(
                    (invoice) =>
                      !allocating.client_id ||
                      invoice.client_id === allocating.client_id,
                  )
                  .map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number} · {invoice.client_code} ·{" "}
                      {formatRupiah(invoice.total_idr - invoice.paid_idr)}{" "}
                      unpaid
                    </option>
                  ))}
              </select>
            </label>
            <p className="text-body-md text-on-surface" aria-live="polite">
              {allocationProblem ??
                `${formatRupiah(remaining)} from this payment settles the invoice in full.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy || allocationProblem !== null}
                className="app-btn app-btn-primary"
              >
                {busy ? "Saving…" : "Allocate"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAllocating(null)}
                className="app-btn app-btn-secondary"
              >
                Back
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
