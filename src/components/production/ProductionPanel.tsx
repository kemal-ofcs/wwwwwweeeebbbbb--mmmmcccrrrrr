"use client";

import { type FormEvent, useRef, useState } from "react";
import {
  MATERIAL_STATUS_LABEL,
  MATERIAL_STATUS_TONE,
  PO_STATUS_LABEL,
} from "@/components/samples/labels";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BatchRecord,
  createBatch,
  markMaterialsReady,
  type PurchaseOrderRecord,
  recordBatchStage,
  recordPurchaseOrder,
  type ShipmentRecord,
  type StageLogEntry,
  type SupplierOption,
  saveBatchSchedule,
} from "@/lib/gateways/production";
import type { MouRecord } from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import {
  type BatchScheduleInput,
  batchRequestError,
  CARTON_COUNT_MAX,
  materialsReadyError,
  PO_NUMBER_MAX,
  type PoAction,
  PRODUCTION_REASON_MAX,
  PRODUCTION_STAGES,
  SCHEDULE_STAGES,
  STAGE_LABEL,
  shipGateError,
  shipStateFromRow,
  stageGateError,
  storageFeeDue,
} from "@/lib/validations/production";
import { formatRupiah } from "@/lib/validations/sample";
import { ShipmentSection } from "./ShipmentSection";

/**
 * Work order satu MoU (v3.1-v3.2, PRD F-23/F-24/F-25): bahan, PO, jadwal
 * SPV, dan 4 tahap lantai produksi.
 * Dipakai halaman Production dan detail tiket sampel. Aturannya diputuskan
 * backend (`production.ts` ↔ `production.rs`); tombol hanya menawarkan yang
 * sah menurut fungsi yang sama.
 */

const PO_ACTION_LABEL: Record<string, string> = {
  PO_ARRIVED: "Arrived",
  PO_LATE: "Report late",
  PO_CANCEL: "Cancel PO",
};

const EMPTY_ORDER = { po_number: "", supplier_option_id: "", eta_on: "" };

/** Tanggal jadwal tahap ke-`index` (urut `SCHEDULE_STAGES`). */
function scheduledOn(batch: BatchRecord, index: number) {
  const key = SCHEDULE_STAGES[index]?.[0];
  return key ? String(batch[`sched_${key}` as keyof BatchRecord] ?? "") : "";
}

/**
 * Tahap berikutnya melewati tanggal jadwalnya (keputusan F v3.2). Dihitung
 * saat dibaca dengan tanggal perangkat; hanya tampilan, tidak disimpan.
 */
export function isBehind(batch: BatchRecord, today: string) {
  if (batch.stages_done >= PRODUCTION_STAGES.length) return false;
  const date = scheduledOn(batch, batch.stages_done);
  return date !== "" && date < today;
}

/** `YYYY-MM-DD` hari ini menurut jam perangkat. */
export function deviceToday() {
  return new Date().toLocaleDateString("en-CA");
}

export function ProductionPanel({
  mou,
  batch,
  purchaseOrders,
  suppliers,
  stageLog,
  shipments,
  carriers,
  storageSopText,
  onChanged,
}: {
  /** MoU work order ini; dipakai untuk menawarkan "Create work order". */
  mou: MouRecord | null;
  batch: BatchRecord | null;
  purchaseOrders: PurchaseOrderRecord[];
  suppliers: SupplierOption[];
  /** Penanda tahap (`STAGE_*`) di linimasa tiket work order ini. */
  stageLog: StageLogEntry[];
  /** Pengiriman (v3.4), pilihan ekspedisi, dan teks SOP Penyimpanan. */
  shipments: ShipmentRecord[];
  carriers: SupplierOption[];
  storageSopText: string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const canPpic = hasPermission(user, "ppic.manage");
  const canSchedule = hasPermission(user, "production.manage");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<typeof EMPTY_ORDER | null>(null);
  const [step, setStep] = useState<{
    poId: string;
    action: PoAction;
    eta_on: string;
    reason: string;
  } | null>(null);
  const [schedule, setSchedule] = useState<BatchScheduleInput | null>(null);
  const [stageDraft, setStageDraft] = useState<{
    notes: string;
    carton_count: string;
    produced_units: string;
  } | null>(null);
  const today = deviceToday();
  const isSubmittingRef = useRef(false);

  const run = async (work: () => Promise<unknown>, after: () => void) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      after();
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The change was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (!batch) {
    if (!mou || mou.status !== "ACCEPTED") return null;
    const blocked = batchRequestError(mou.status, mou.dp_cleared === 1, 0);
    return (
      <section aria-label="Production" className="grid gap-3">
        <h3 className="text-body-md font-semibold text-on-surface">
          Production
        </h3>
        <p className="text-body-sm text-on-surface-variant">
          {blocked ?? "PPIC can create the work order for this MoU."}
        </p>
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        {canPpic && !blocked ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => createBatch(mou.id),
                  () => undefined,
                )
              }
              className="app-btn app-btn-primary"
            >
              {busy ? "Creating…" : "Create work order"}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const orders = purchaseOrders.filter((po) => po.batch_id === batch.id);
  const readyBlocked = materialsReadyError(
    batch.material_status,
    batch.open_orders,
  );
  const hasSchedule = batch.sched_packing_on !== "";
  // PO dan bahan terkunci setelah Penimbangan (keputusan G v3.2).
  const started = batch.stages_done > 0;
  const packed = batch.stages_done >= PRODUCTION_STAGES.length;
  // Gerbang kirim dan biaya titip (v3.3), dihitung dari `BATCH_LIST_SQL`.
  const shipState = shipStateFromRow(
    batch as unknown as Record<string, unknown>,
  );
  const shipBlock = shipGateError(shipState);
  const storageFee = storageFeeDue(shipState);
  const stageBlocked = stageGateError({
    stages_done: batch.stages_done,
    material_status: batch.material_status,
    has_schedule: hasSchedule,
    legal_open: batch.legal_open,
  });
  const activeSuppliers = suppliers.filter((option) => option.is_active === 1);

  const submitOrder = (event: FormEvent) => {
    event.preventDefault();
    if (!order) return;
    void run(
      () =>
        recordPurchaseOrder(batch.id, {
          action: "PO_ADD",
          po_id: "",
          order,
          delay: null,
        }),
      () => setOrder(null),
    );
  };

  const submitStep = (event: FormEvent) => {
    event.preventDefault();
    if (!step) return;
    void run(
      () =>
        recordPurchaseOrder(batch.id, {
          action: step.action,
          po_id: step.poId,
          order: null,
          delay:
            step.action === "PO_LATE"
              ? { eta_on: step.eta_on, reason: step.reason }
              : null,
        }),
      () => setStep(null),
    );
  };

  const submitStage = (event: FormEvent) => {
    event.preventDefault();
    if (!stageDraft) return;
    const packing = batch.stages_done === PRODUCTION_STAGES.length - 1;
    void run(
      () =>
        recordBatchStage(batch.id, {
          notes: stageDraft.notes,
          carton_count: packing ? Number(stageDraft.carton_count) : null,
          produced_units: packing ? Number(stageDraft.produced_units) : null,
        }),
      () => setStageDraft(null),
    );
  };

  const submitSchedule = (event: FormEvent) => {
    event.preventDefault();
    if (!schedule) return;
    void run(
      () => saveBatchSchedule(batch.id, schedule),
      () => setSchedule(null),
    );
  };

  return (
    <section aria-label="Production" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body-md font-semibold text-on-surface">
          Work order <span className="font-mono">{batch.batch_code}</span>
        </h3>
        <StatusBadge tone={MATERIAL_STATUS_TONE[batch.material_status]}>
          {MATERIAL_STATUS_LABEL[batch.material_status] ??
            batch.material_status}
        </StatusBadge>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        MoU {batch.mou_number}, {batch.total_units.toLocaleString("en-US")}{" "}
        units, production lead time {batch.production_lead_time_days} days.
      </p>
      {batch.needs_reschedule === 1 ? (
        <FeedbackBanner tone="warning">
          A purchase order is late. Production SPV must check the schedule.
        </FeedbackBanner>
      ) : null}
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-2">
        <h4 className="text-body-sm font-semibold text-on-surface">
          Purchase orders
        </h4>
        {orders.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            No purchase orders. If every material is in stock, mark the
            materials as ready.
          </p>
        ) : (
          <ul className="grid gap-2">
            {orders.map((po) => (
              <li
                key={po.id}
                className="grid gap-1 rounded-md border border-surface-container p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body-md text-on-surface">
                    <span className="font-mono">{po.po_number}</span> ·{" "}
                    {po.supplier_label || "Unknown supplier"} · arriving{" "}
                    {po.eta_on}
                  </span>
                  <StatusBadge
                    tone={
                      po.status === "ARRIVED"
                        ? "success"
                        : po.status === "OPEN"
                          ? "info"
                          : "neutral"
                    }
                  >
                    {PO_STATUS_LABEL[po.status] ?? po.status}
                  </StatusBadge>
                </div>
                {po.late_reason ? (
                  <p className="text-body-sm text-on-surface-variant">
                    Late: {po.late_reason}
                  </p>
                ) : null}
                {canPpic &&
                !started &&
                po.status === "OPEN" &&
                step?.poId !== po.id ? (
                  <div className="flex flex-wrap gap-2">
                    {(["PO_ARRIVED", "PO_LATE", "PO_CANCEL"] as const).map(
                      (action) => (
                        <button
                          key={action}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setStep({
                              poId: po.id,
                              action,
                              eta_on: "",
                              reason: "",
                            })
                          }
                          className="app-btn app-btn-secondary"
                        >
                          {PO_ACTION_LABEL[action]}
                        </button>
                      ),
                    )}
                  </div>
                ) : null}
                {step?.poId === po.id ? (
                  <form
                    onSubmit={submitStep}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {step.action === "PO_LATE" ? (
                      <>
                        <label className="app-label grid gap-1.5">
                          New arrival date
                          <input
                            required
                            type="date"
                            min={po.eta_on}
                            value={step.eta_on}
                            onChange={(event) =>
                              setStep({ ...step, eta_on: event.target.value })
                            }
                            className="app-input font-normal"
                          />
                        </label>
                        <label className="app-label grid gap-1.5">
                          Why is it late?
                          <input
                            required
                            maxLength={PRODUCTION_REASON_MAX}
                            value={step.reason}
                            onChange={(event) =>
                              setStep({ ...step, reason: event.target.value })
                            }
                            className="app-input font-normal"
                          />
                        </label>
                      </>
                    ) : (
                      <p className="text-body-sm text-on-surface-variant sm:col-span-2">
                        {step.action === "PO_ARRIVED"
                          ? "Confirm that everything on this order has arrived."
                          : "Cancel this purchase order? This cannot be undone."}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="app-btn app-btn-primary"
                      >
                        {busy ? "Saving…" : PO_ACTION_LABEL[step.action]}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStep(null)}
                        className="app-btn app-btn-secondary"
                      >
                        Back
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canPpic && order ? (
          <form
            onSubmit={submitOrder}
            className="grid gap-3 rounded-md border border-surface-container p-3 sm:grid-cols-3"
          >
            <label className="app-label grid gap-1.5">
              PO number
              <input
                required
                maxLength={PO_NUMBER_MAX}
                value={order.po_number}
                onChange={(event) =>
                  setOrder({ ...order, po_number: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Supplier
              <select
                required
                value={order.supplier_option_id}
                onChange={(event) =>
                  setOrder({ ...order, supplier_option_id: event.target.value })
                }
                className="app-input font-normal"
              >
                <option value="">Choose</option>
                {activeSuppliers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="app-label grid gap-1.5">
              Expected arrival
              <input
                required
                type="date"
                value={order.eta_on}
                onChange={(event) =>
                  setOrder({ ...order, eta_on: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            {activeSuppliers.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant sm:col-span-3">
                No suppliers yet. Ask Admin to add them in Master Data ›
                Suppliers.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 sm:col-span-3">
              <button
                type="submit"
                disabled={busy}
                className="app-btn app-btn-primary"
              >
                {busy ? "Saving…" : "Save purchase order"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOrder(null)}
                className="app-btn app-btn-secondary"
              >
                Back
              </button>
            </div>
          </form>
        ) : null}

        {canPpic && !order && !started ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOrder(EMPTY_ORDER)}
              className="app-btn app-btn-secondary"
            >
              Add purchase order
            </button>
            {!readyBlocked ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => markMaterialsReady(batch.id),
                    () => undefined,
                  )
                }
                className="app-btn app-btn-primary"
              >
                Materials ready
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-2">
        <h4 className="text-body-sm font-semibold text-on-surface">Schedule</h4>
        {hasSchedule ? (
          <dl className="grid gap-1 text-body-sm sm:grid-cols-4">
            {SCHEDULE_STAGES.map(([key, label]) => (
              <div key={key}>
                <dt className="capitalize text-on-surface-variant">{label}</dt>
                <dd className="font-mono text-on-surface">
                  {batch[`sched_${key}` as keyof BatchRecord]}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-body-sm text-on-surface-variant">
            Not scheduled yet.
          </p>
        )}
        {canSchedule && schedule ? (
          <form
            onSubmit={submitSchedule}
            className="grid gap-3 rounded-md border border-surface-container p-3 sm:grid-cols-4"
          >
            {SCHEDULE_STAGES.map(([key, label], index) => (
              <label key={key} className="app-label grid gap-1.5 capitalize">
                {label}
                <input
                  required
                  // Tanggal tahap yang sudah selesai tidak berubah (keputusan G).
                  readOnly={index < batch.stages_done}
                  type="date"
                  value={schedule[key]}
                  onChange={(event) =>
                    setSchedule({ ...schedule, [key]: event.target.value })
                  }
                  className="app-input font-normal"
                />
              </label>
            ))}
            <label className="app-label grid gap-1.5 sm:col-span-4">
              {hasSchedule
                ? "Why does the schedule change?"
                : "Notes (optional)"}
              <input
                required={hasSchedule}
                maxLength={PRODUCTION_REASON_MAX}
                value={schedule.reason}
                onChange={(event) =>
                  setSchedule({ ...schedule, reason: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-4">
              <button
                type="submit"
                disabled={busy}
                className="app-btn app-btn-primary"
              >
                {busy ? "Saving…" : "Save schedule"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setSchedule(null)}
                className="app-btn app-btn-secondary"
              >
                Back
              </button>
            </div>
          </form>
        ) : null}
        {canSchedule && !schedule && !packed ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setSchedule({
                  weighing_on: batch.sched_weighing_on,
                  mixing_on: batch.sched_mixing_on,
                  filling_on: batch.sched_filling_on,
                  packing_on: batch.sched_packing_on,
                  reason: "",
                })
              }
              className="app-btn app-btn-secondary"
            >
              {hasSchedule ? "Change schedule" : "Set schedule"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-2">
        <h4 className="text-body-sm font-semibold text-on-surface">
          Production floor
        </h4>
        {packed ? (
          <p className="text-body-sm text-on-surface-variant">
            Packed {formatDateTime(batch.packed_at)}: {batch.carton_count}{" "}
            cartons, {batch.produced_units.toLocaleString("en-US")} units.
          </p>
        ) : null}
        <ol className="grid gap-2">
          {PRODUCTION_STAGES.map((stage, index) => {
            const date = scheduledOn(batch, index);
            const entry = stageLog.find(
              (log) => log.action === `STAGE_${stage}`,
            );
            const isNext = index === batch.stages_done;
            return (
              <li
                key={stage}
                className="grid gap-2 rounded-md border border-surface-container p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body-md font-semibold text-on-surface">
                    {index + 1}. {STAGE_LABEL[stage]}
                    {date ? (
                      <span className="ml-2 font-mono font-normal text-body-sm text-on-surface-variant">
                        {date}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {isNext && isBehind(batch, today) ? (
                      <StatusBadge tone="danger">Behind schedule</StatusBadge>
                    ) : null}
                    <StatusBadge
                      tone={
                        index < batch.stages_done
                          ? "success"
                          : isNext
                            ? "info"
                            : "neutral"
                      }
                    >
                      {index < batch.stages_done
                        ? "Done"
                        : isNext
                          ? "Next"
                          : "Waiting"}
                    </StatusBadge>
                  </span>
                </div>
                {entry ? (
                  <p className="text-body-sm text-on-surface-variant">
                    {entry.recorded_by_name ?? "Someone"} ·{" "}
                    {formatDateTime(entry.recorded_at)} · {entry.notes}
                  </p>
                ) : null}
                {isNext && canSchedule && stageBlocked ? (
                  <p className="text-body-sm text-on-surface-variant">
                    {stageBlocked}
                  </p>
                ) : null}
                {isNext && canSchedule && !stageBlocked && !stageDraft ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setStageDraft({
                        notes: "",
                        carton_count: "",
                        produced_units: String(batch.total_units),
                      })
                    }
                    className="app-btn app-btn-primary min-h-12 w-full sm:w-auto"
                  >
                    Mark {STAGE_LABEL[stage].toLowerCase()} done
                  </button>
                ) : null}
                {isNext && stageDraft ? (
                  <form
                    onSubmit={submitStage}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {stage === "PACKING" ? (
                      <>
                        <label className="app-label grid gap-1.5">
                          Cartons
                          <input
                            required
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={CARTON_COUNT_MAX}
                            value={stageDraft.carton_count}
                            onChange={(event) =>
                              setStageDraft({
                                ...stageDraft,
                                carton_count: event.target.value,
                              })
                            }
                            className="app-input font-normal"
                          />
                        </label>
                        <label className="app-label grid gap-1.5">
                          Finished units
                          <input
                            required
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={stageDraft.produced_units}
                            onChange={(event) =>
                              setStageDraft({
                                ...stageDraft,
                                produced_units: event.target.value,
                              })
                            }
                            className="app-input font-normal"
                          />
                        </label>
                      </>
                    ) : null}
                    <label className="app-label grid gap-1.5 sm:col-span-2">
                      Notes (optional, e.g. the crew)
                      <input
                        maxLength={PRODUCTION_REASON_MAX}
                        value={stageDraft.notes}
                        onChange={(event) =>
                          setStageDraft({
                            ...stageDraft,
                            notes: event.target.value,
                          })
                        }
                        className="app-input font-normal"
                      />
                    </label>
                    <p className="text-body-sm text-on-surface-variant sm:col-span-2">
                      This cannot be undone. Confirm only when{" "}
                      {STAGE_LABEL[stage].toLowerCase()} is really finished.
                    </p>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="app-btn app-btn-primary min-h-12"
                      >
                        {busy
                          ? "Saving…"
                          : `Confirm ${STAGE_LABEL[stage].toLowerCase()} done`}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setStageDraft(null)}
                        className="app-btn app-btn-secondary min-h-12"
                      >
                        Back
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      {packed ? (
        <div className="grid gap-2">
          <h4 className="text-body-sm font-semibold text-on-surface">
            Settlement &amp; storage
          </h4>
          <FeedbackBanner tone={shipBlock ? "warning" : "success"}>
            {shipBlock ?? "Cleared to ship. Logistics can record the shipment."}
          </FeedbackBanner>
          <p className="text-body-sm text-on-surface-variant">
            {batch.storage_days > 0
              ? `Held in storage ${batch.storage_days} chargeable day${batch.storage_days === 1 ? "" : "s"} after ${batch.storage_grace_days} free days. Storage fee so far ${formatRupiah(storageFee)} (${batch.carton_count} cartons × ${formatRupiah(batch.storage_rate_idr)} per day).`
              : `Storage is free for ${batch.storage_grace_days} days after packing${batch.storage_rate_idr > 0 ? `, then ${formatRupiah(batch.storage_rate_idr)} per carton per day` : ""}.`}
          </p>
          {batch.settlement_paid_on &&
          batch.settlement_count > 0 &&
          batch.settlement_unpaid === 0 ? (
            <p className="text-body-sm text-on-surface-variant">
              Settlement paid {batch.settlement_paid_on}.
            </p>
          ) : null}
        </div>
      ) : null}
      {packed ? (
        <ShipmentSection
          batch={batch}
          shipments={shipments}
          carriers={carriers}
          storageSopText={storageSopText}
          shipBlock={shipBlock}
          onChanged={onChanged}
        />
      ) : null}
    </section>
  );
}
