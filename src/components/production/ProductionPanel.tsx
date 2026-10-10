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
  recordPurchaseOrder,
  type SupplierOption,
  saveBatchSchedule,
} from "@/lib/gateways/production";
import type { MouRecord } from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  type BatchScheduleInput,
  batchRequestError,
  materialsReadyError,
  PO_NUMBER_MAX,
  type PoAction,
  PRODUCTION_REASON_MAX,
  SCHEDULE_STAGES,
} from "@/lib/validations/production";

/**
 * Work order satu MoU (v3.1, PRD F-23/F-24): bahan, PO, dan jadwal SPV.
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

export function ProductionPanel({
  mou,
  batch,
  purchaseOrders,
  suppliers,
  onChanged,
}: {
  /** MoU work order ini; dipakai untuk menawarkan "Create work order". */
  mou: MouRecord | null;
  batch: BatchRecord | null;
  purchaseOrders: PurchaseOrderRecord[];
  suppliers: SupplierOption[];
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
                {canPpic && po.status === "OPEN" && step?.poId !== po.id ? (
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

        {canPpic && !order ? (
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
            {SCHEDULE_STAGES.map(([key, label]) => (
              <label key={key} className="app-label grid gap-1.5 capitalize">
                {label}
                <input
                  required
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
        {canSchedule && !schedule ? (
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
    </section>
  );
}
