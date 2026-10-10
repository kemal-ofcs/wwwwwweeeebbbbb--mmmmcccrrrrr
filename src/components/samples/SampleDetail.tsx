"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { downloadInvoicePdf } from "@/components/finance/invoice-download";
import {
  INVOICE_TYPE_LABEL,
  invoiceStatusLabel,
  invoiceTone,
} from "@/components/finance/labels";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import type { MasterOptionRecord } from "@/lib/gateways/clients";
import type { InvoiceRecord } from "@/lib/gateways/finance";
import {
  getSampleRequest,
  recordSampleStep,
  type SampleDetail as SampleDetailData,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import { isClientDecisionAction } from "@/lib/validations/approval";
import {
  applySampleAction,
  FORMULA_CODE_MAX,
  formatRupiah,
  PRODUCT_KNOWLEDGE_MAX,
  SAMPLE_ACTIONS,
  SAMPLE_NOTES_MAX,
  type SampleAction,
  sampleActionPermission,
} from "@/lib/validations/sample";
import { ClientApproval } from "./ClientApproval";
import { EvidencePicker } from "./EvidencePicker";
import {
  DESIGN_STATUS_LABEL,
  LEGAL_STATUS_LABEL,
  MOU_STATUS_LABEL,
  nextSampleStep,
  SAMPLE_ACTION_LABEL,
  SAMPLE_ACTION_PAST,
  SAMPLE_STATUS_LABEL,
  SAMPLE_STATUS_TONE,
} from "./labels";
import { SampleDesign } from "./SampleDesign";
import { SampleLegal } from "./SampleLegal";
import { SampleMou } from "./SampleMou";
import { SamplePhotos } from "./SamplePhotos";
import { SamplePricing } from "./SamplePricing";

/**
 * Detail tiket sampel (SCR-03): ringkasan, kuota revisi, linimasa langkah,
 * dan pencatatan langkah berikutnya. Langkah yang ditawarkan dihitung dengan
 * `applySampleAction` yang sama dengan backend; backend tetap memutuskan.
 */

interface SampleDetailProps {
  id: string;
  optionLabel: (id: string) => string;
  canManage: boolean;
  /** `rnd.manage`: langkah RnD (v2.1). */
  canRnd: boolean;
  /** `finance.manage`: harga, tarif revisi, pembayaran diterima (v2.2). */
  canFinance: boolean;
  /** Pilihan Master Data `RND_REJECT_REASON` yang aktif. */
  rejectReasons: MasterOptionRecord[];
  onEdit: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
}

const PRODUCT_CLASS_LABEL: Record<string, string> = {
  NEW: "New product",
  EXISTING: "Existing product",
};

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-body-md">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-on-surface">{value}</dd>
    </div>
  );
}

/** Linimasa memuat langkah tiket sampel, tiket desain (v2.4), dan MoU (v2.5a). */
function statusLabel(status: string) {
  return (
    SAMPLE_STATUS_LABEL[status] ??
    DESIGN_STATUS_LABEL[status] ??
    MOU_STATUS_LABEL[status] ??
    LEGAL_STATUS_LABEL[status] ??
    status
  );
}

export function SampleDetail({
  id,
  optionLabel,
  canManage,
  canRnd,
  canFinance,
  rejectReasons,
  onEdit,
  onOpen,
  onChanged,
  onClose,
}: SampleDetailProps) {
  const [data, setData] = useState<SampleDetailData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { user } = useAuth();
  const canInvoices = hasPermission(user, "invoices.view");
  const canDesign = hasPermission(user, "design.manage");
  const [action, setAction] = useState<SampleAction | null>(null);
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [revisionFee, setRevisionFee] = useState("");
  const [productClass, setProductClass] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [formulaCode, setFormulaCode] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getSampleRequest(id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request could not be loaded.",
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const request = data?.request;
  const limit = request?.free_revision_limit ?? 0;
  const allowed = {
    "rnd.manage": canRnd,
    "finance.manage": canFinance,
    "samples.manage": canManage,
  };
  const available = request
    ? SAMPLE_ACTIONS.filter(
        (candidate) =>
          allowed[sampleActionPermission(candidate)] &&
          !(
            "error" in
            applySampleAction(
              {
                status: request.status,
                is_paid_sample: request.is_paid_sample === 1,
                revision_index: request.revision_index,
                free_revision_limit: limit,
                has_price: request.unit_price_idr != null,
                fee_paid: request.fee_paid === 1,
                test_ready:
                  request.is_test_requested !== 1 || request.test_paid === 1,
                mockup_ready: request.mockup_ready === 1,
              },
              candidate,
              1,
              0,
            )
          ),
      )
    : [];

  // Sampel revisi biasanya berangkat dari formula iterasi sebelumnya, jadi
  // isian Sample ready dimulai dari sana dan RnD mengubah seperlunya.
  const chooseAction = (candidate: SampleAction) => {
    setAction(candidate);
    const last = data?.formulas[data.formulas.length - 1];
    if (candidate === "SAMPLE_READY" && last && formulaCode === "") {
      setFormulaCode(last.formula_code);
      setKnowledge(last.product_knowledge);
    }
  };

  const submitStep = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await recordSampleStep({
        id,
        action,
        notes,
        lead_time_days: leadTime === "" ? null : Math.trunc(Number(leadTime)),
        rnd: {
          product_class: productClass,
          reject_reason_option_id: rejectReason,
          formula_code: formulaCode,
          product_knowledge: knowledge,
        },
        revision_fee_idr:
          revisionFee === "" ? null : Math.trunc(Number(revisionFee)),
        evidence_base64: isClientDecisionAction(action) ? evidence : "",
      });
      setAction(null);
      setNotes("");
      setEvidence("");
      setLeadTime("");
      setRevisionFee("");
      setProductClass("");
      setRejectReason("");
      setFormulaCode("");
      setKnowledge("");
      await load();
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The step was not recorded.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

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

  let special: Record<string, string> = {};
  try {
    special = JSON.parse(request?.special_requests_json ?? "{}");
  } catch {
    special = {};
  }
  const specialText = ["color", "texture", "size", "aroma"]
    .filter((key) => special[key])
    .map((key) => `${key}: ${special[key]}`)
    .join(" · ");
  const closed = [
    "RND_REJECTED",
    "CLIENT_ACC",
    "CLIENT_REJECT",
    "CANCELLED",
  ].includes(request?.status ?? "");

  return (
    <Modal
      title={request ? `${request.brand_name}` : "Sample request"}
      titleId="sample-detail-title"
      onClose={onClose}
    >
      <div className="grid gap-4">
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
        {!request ? (
          <p className="text-body-md text-on-surface-variant">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={SAMPLE_STATUS_TONE[request.status] ?? "neutral"}
              >
                {SAMPLE_STATUS_LABEL[request.status] ?? request.status}
              </StatusBadge>
              <span className="text-body-sm text-on-surface-variant">
                {request.client_code} · {request.client_name}
              </span>
            </div>
            {nextSampleStep(request) ? (
              <p className="rounded-md bg-surface-container-low px-3 py-2 text-body-sm text-on-surface">
                <span className="font-semibold">Next step:</span>{" "}
                {nextSampleStep(request)}
              </p>
            ) : null}

            <section
              aria-label="Revision quota"
              className="rounded-md border border-surface-container p-3"
            >
              <p className="text-body-md text-on-surface">
                Revision {request.revision_index} ·{" "}
                {Math.max(0, limit - request.revision_index)} of {limit} free
                revisions left
              </p>
              {request.is_billable === 1 ? (
                <p className="mt-1 text-body-sm text-on-surface-variant">
                  This revision is over the free quota and waits for Finance to
                  set the fee.
                </p>
              ) : null}
            </section>

            <dl className="grid gap-1.5">
              <DetailRow
                label="Product type"
                value={optionLabel(request.product_category_option_id)}
              />
              <DetailRow
                label="Sample kind"
                value={optionLabel(request.sample_kind_option_id)}
              />
              <DetailRow
                label="Formulation"
                value={optionLabel(request.formulation_type_option_id)}
              />
              <DetailRow
                label="Registration"
                value={optionLabel(request.registration_category_option_id)}
              />
              <DetailRow label="Samples" value={String(request.sample_qty)} />
              <DetailRow label="Packaging" value={request.packaging} />
              <DetailRow label="BPOM name" value={request.bpom_product_name} />
              <DetailRow label="Claims" value={request.claims} />
              <DetailRow label="Reference" value={request.reference_notes} />
              <DetailRow label="Special requests" value={specialText} />
              <DetailRow
                label="Budget"
                value={
                  request.client_budget_idr == null
                    ? ""
                    : `Rp ${request.client_budget_idr.toLocaleString("id-ID")}`
                }
              />
              <DetailRow label="Deadline" value={request.deadline_at} />
              <DetailRow label="Ship to" value={request.ship_to_address} />
              <DetailRow
                label="Fee"
                value={
                  request.is_paid_sample === 1 ? "Paid sample" : "Free sample"
                }
              />
              <DetailRow
                label="Testing"
                value={
                  request.is_test_requested === 1
                    ? request.test_paid === 1
                      ? "Requested, fee paid"
                      : "Requested, fee not paid yet"
                    : "Not requested"
                }
              />
              <DetailRow
                label="Packaging dummy"
                value={
                  request.is_dummy_required === 1 ? "Needed" : "Not needed"
                }
              />
              <DetailRow
                label="RnD lead time"
                value={
                  request.rnd_lead_time_days == null
                    ? ""
                    : `${request.rnd_lead_time_days} days`
                }
              />
              <DetailRow
                label="Product class"
                value={PRODUCT_CLASS_LABEL[request.rnd_product_class] ?? ""}
              />
              <DetailRow
                label="Rejection reason"
                value={optionLabel(request.rnd_reject_reason_option_id)}
              />
              <DetailRow
                label="Revision fee"
                value={
                  request.revision_fee_idr == null
                    ? ""
                    : formatRupiah(request.revision_fee_idr)
                }
              />
              <DetailRow label="PIC CRM" value={request.pic_crm_name ?? ""} />
            </dl>

            <SamplePricing
              sampleId={request.id}
              status={request.status}
              iteration={request.revision_index + 1}
              prices={data.prices}
              canPrice={canFinance}
              onSaved={() => {
                void load();
                onChanged();
              }}
            />

            {data.invoices.length > 0 || canFinance ? (
              <section aria-label="Invoices" className="grid gap-2">
                <h3 className="text-body-md font-semibold text-on-surface">
                  Invoices
                </h3>
                {data.invoices.length === 0 ? (
                  <p className="text-body-sm text-on-surface-variant">
                    No invoices for this sample yet.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {data.invoices.map((invoice) => (
                      <li
                        key={invoice.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-container p-3"
                      >
                        <span className="text-body-md text-on-surface">
                          <span className="font-mono">
                            {invoice.invoice_number}
                          </span>{" "}
                          ·{" "}
                          {INVOICE_TYPE_LABEL[invoice.ref_type] ??
                            invoice.ref_type}{" "}
                          · {formatRupiah(invoice.total_idr)}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge tone={invoiceTone(invoice)}>
                            {invoiceStatusLabel(invoice)}
                          </StatusBadge>
                          {canInvoices ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void exportPdf(invoice)}
                              className="app-btn app-btn-secondary"
                            >
                              PDF
                            </button>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {canFinance ? (
                  <Link
                    href={`/finance?sample=${encodeURIComponent(request.id)}`}
                    className="app-btn app-btn-secondary justify-self-start"
                  >
                    Create invoice
                  </Link>
                ) : null}
              </section>
            ) : null}

            {request.status === "SAMPLE_SENT" ? (
              <ClientApproval
                entityType="SAMPLE"
                entityId={request.id}
                linkEnabled={data.approval_link_enabled}
                canCreate={canManage}
                title={`Sample ${request.brand_name}, iteration ${request.revision_index + 1}`}
                lines={[
                  `For ${request.client_name ?? ""} (${request.client_code ?? ""})`,
                  `Packaging: ${request.packaging}`,
                  ...(request.unit_price_idr == null
                    ? []
                    : [
                        `Unit price before tax: ${formatRupiah(request.unit_price_idr)}`,
                      ]),
                ]}
                decisions={["APPROVE", "REVISE", "REJECT"]}
              />
            ) : null}

            <SampleDesign
              sample={request}
              design={data.design}
              maxRejections={data.max_dummy_rejections}
              canManage={canManage}
              linkEnabled={data.approval_link_enabled}
              onChanged={() => {
                void load();
                onChanged();
              }}
            />

            <SampleMou
              sample={request}
              mou={data.mou}
              dpDefaultBp={data.dp_percentage_bp}
              linkEnabled={data.approval_link_enabled}
              onChanged={() => {
                void load();
                onChanged();
              }}
            />

            <SampleLegal
              mou={data.mou}
              documents={data.legal_documents}
              onChanged={() => {
                void load();
                onChanged();
              }}
            />

            <SamplePhotos
              sampleId={request.id}
              media={data.media}
              canUpload={canManage && !closed}
              canUploadPaymentProof={request.is_paid_sample === 1}
              canUploadMockup={
                canDesign &&
                data.design !== null &&
                data.design.status !== "CANCELLED"
              }
              onUploaded={() => {
                void load();
                onChanged();
              }}
            />

            {canManage && !closed ? (
              <button
                type="button"
                onClick={onEdit}
                className="app-btn app-btn-secondary justify-self-start"
              >
                Edit request
              </button>
            ) : null}

            {available.length > 0 ? (
              <section aria-label="Record the next step" className="grid gap-3">
                <h3 className="text-body-md font-semibold text-on-surface">
                  Record the next step
                </h3>
                <div className="flex flex-wrap gap-2">
                  {available.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={action === candidate}
                      onClick={() => chooseAction(candidate)}
                      className={`app-btn ${
                        action === candidate
                          ? "app-btn-primary"
                          : candidate === "CANCEL"
                            ? "app-btn-danger"
                            : "app-btn-secondary"
                      }`}
                    >
                      {SAMPLE_ACTION_LABEL[candidate]}
                    </button>
                  ))}
                </div>
                {action ? (
                  <form onSubmit={submitStep} className="grid gap-3">
                    {action === "RND_ACCEPT" || action === "RND_REJECT" ? (
                      <label className="app-label grid gap-1.5 sm:max-w-xs">
                        {action === "RND_ACCEPT"
                          ? "Product class"
                          : "Product class (optional)"}
                        <select
                          required={action === "RND_ACCEPT"}
                          value={productClass}
                          onChange={(event) =>
                            setProductClass(event.target.value)
                          }
                          className="app-input font-normal"
                        >
                          <option value="">Choose…</option>
                          <option value="NEW">
                            New product (needs research)
                          </option>
                          <option value="EXISTING">
                            Existing product (confirm with Production)
                          </option>
                        </select>
                      </label>
                    ) : null}
                    {action === "RND_REJECT" ? (
                      rejectReasons.length === 0 ? (
                        <p className="text-body-sm text-on-surface-variant">
                          No rejection reasons yet. Add them under Master Data ›
                          RnD rejection reasons first.
                        </p>
                      ) : (
                        <label className="app-label grid gap-1.5 sm:max-w-sm">
                          Rejection reason
                          <select
                            required
                            value={rejectReason}
                            onChange={(event) =>
                              setRejectReason(event.target.value)
                            }
                            className="app-input font-normal"
                          >
                            <option value="">Choose…</option>
                            {rejectReasons.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )
                    ) : null}
                    {action === "SAMPLE_READY" ? (
                      <>
                        <label className="app-label grid gap-1.5 sm:max-w-xs">
                          Formula code
                          <input
                            required
                            maxLength={FORMULA_CODE_MAX}
                            value={formulaCode}
                            onChange={(event) =>
                              setFormulaCode(event.target.value)
                            }
                            className="app-input font-mono font-normal"
                          />
                        </label>
                        <label className="app-label grid gap-1.5">
                          Product knowledge
                          <textarea
                            required
                            rows={4}
                            maxLength={PRODUCT_KNOWLEDGE_MAX}
                            value={knowledge}
                            onChange={(event) =>
                              setKnowledge(event.target.value)
                            }
                            placeholder="Texture, key ingredients, usage, and what CS should tell the client"
                            className="app-input min-h-24 py-2 font-normal"
                          />
                        </label>
                      </>
                    ) : null}
                    {action === "SET_REVISION_FEE" ? (
                      <label className="app-label grid gap-1.5 sm:max-w-xs">
                        Revision fee (rupiah, 0 waives it)
                        <input
                          required
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          value={revisionFee}
                          onChange={(event) =>
                            setRevisionFee(event.target.value)
                          }
                          className="app-input font-normal"
                        />
                      </label>
                    ) : null}
                    {action === "RND_ACCEPT" ? (
                      <label className="app-label grid gap-1.5 sm:max-w-xs">
                        RnD lead time in days
                        <input
                          required
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={leadTime}
                          onChange={(event) => setLeadTime(event.target.value)}
                          className="app-input font-normal"
                        />
                      </label>
                    ) : null}
                    {isClientDecisionAction(action) ? (
                      <EvidencePicker value={evidence} onChange={setEvidence} />
                    ) : null}
                    <label className="app-label grid gap-1.5">
                      Notes
                      <textarea
                        required
                        rows={3}
                        maxLength={SAMPLE_NOTES_MAX}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder="What was decided, and by whom"
                        className="app-input min-h-20 py-2 font-normal"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="app-btn app-btn-primary"
                      >
                        {busy ? "Saving…" : "Save step"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setAction(null)}
                        className="app-btn app-btn-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            ) : null}

            {data.formulas.length > 0 ? (
              <section aria-label="Formulas" className="grid gap-2">
                <h3 className="text-body-md font-semibold text-on-surface">
                  Formulas
                </h3>
                <ol className="grid gap-3">
                  {data.formulas.map((formula) => (
                    <li
                      key={formula.id}
                      className="grid gap-1 rounded-md border border-surface-container p-3"
                    >
                      <p className="text-body-md text-on-surface">
                        Sample {formula.iteration_number} ·{" "}
                        <span className="font-mono font-semibold">
                          {formula.formula_code}
                        </span>
                      </p>
                      <p className="whitespace-pre-wrap text-body-md text-on-surface">
                        {formula.product_knowledge}
                      </p>
                      <p className="text-body-sm text-on-surface-variant">
                        {formula.recorded_by_name ??
                          `Operator #${formula.recorded_by ?? "?"}`}{" "}
                        · {formatDateTime(formula.recorded_at)}
                      </p>
                    </li>
                  ))}
                </ol>
                {data.formula_matches.length > 0 ? (
                  <div className="grid gap-1">
                    <p className="text-body-sm text-on-surface-variant">
                      Other requests with the same formula code
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {data.formula_matches.map((match) => (
                        <li
                          key={`${match.formula_code}-${match.sample_request_id}`}
                        >
                          <button
                            type="button"
                            onClick={() => onOpen(match.sample_request_id)}
                            className="app-btn app-btn-secondary"
                          >
                            <span className="font-mono">
                              {match.formula_code}
                            </span>{" "}
                            · {match.brand_name}
                            {match.client_code ? ` · ${match.client_code}` : ""}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section aria-label="Timeline" className="grid gap-2">
              <h3 className="text-body-md font-semibold text-on-surface">
                Timeline
              </h3>
              {data.status_log.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">
                  Created {formatDateTime(request.created_at)}. No steps
                  recorded yet.
                </p>
              ) : (
                <ol className="grid gap-3 border-l-2 border-surface-container pl-4">
                  {data.status_log.map((entry) => (
                    <li key={entry.id} className="grid gap-1">
                      <p className="text-body-sm text-on-surface-variant">
                        {formatDateTime(entry.recorded_at)}
                      </p>
                      <p className="text-body-md text-on-surface">
                        <span className="font-semibold">
                          {entry.recorded_by_name ??
                            (entry.recorded_by == null
                              ? "Client"
                              : `Operator #${entry.recorded_by}`)}
                        </span>{" "}
                        {SAMPLE_ACTION_PAST[entry.action] ?? entry.action}
                      </p>
                      <p className="flex flex-wrap items-center gap-1 text-body-sm text-on-surface-variant">
                        {entry.from_status ? (
                          <>
                            <span className="line-through">
                              {statusLabel(entry.from_status)}
                            </span>
                            <span aria-hidden="true">→</span>
                          </>
                        ) : null}
                        <span className="font-semibold text-on-surface">
                          {statusLabel(entry.to_status)}
                        </span>
                      </p>
                      <p className="rounded-md border border-surface-container bg-surface-container-low p-2 text-body-md text-on-surface">
                        {entry.notes}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
