"use client";

import { type FormEvent, useRef, useState } from "react";
import { EvidencePicker } from "@/components/samples/EvidencePicker";
import { SHIPMENT_STATUS_LABEL } from "@/components/samples/labels";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BatchRecord,
  createShipment,
  recordShipmentStep,
  type ShipmentRecord,
  type SupplierOption,
} from "@/lib/gateways/production";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  CARTON_COUNT_MAX,
  type DeliveryMethod,
  PRODUCTION_REASON_MAX,
  SHIP_ADDRESS_MAX,
  type ShipmentAction,
  TRACKING_NO_MAX,
} from "@/lib/validations/production";
import { deviceToday } from "./ProductionPanel";
import {
  downloadDeliveryNote,
  downloadStorageSop,
  shipmentCarrierLine,
} from "./shipment-download";

/**
 * Pengiriman satu work order (v3.4, PRD F-27): Surat Jalan, kirim, resi, dan
 * diteruskan ke klien. Aturannya diputuskan backend (`production.ts` ↔
 * `production.rs`); tombol hanya menawarkan langkah yang sah.
 */

interface Draft {
  method: DeliveryMethod;
  carrier_option_id: string;
  driver_name: string;
  driver_phone: string;
  vehicle_plate: string;
  carton_count: string;
  unit_count: string;
  ship_on: string;
  ship_to_address: string;
  notes: string;
}

function draftOf(shipment: ShipmentRecord): Draft {
  return {
    method: shipment.method,
    carrier_option_id: shipment.carrier_option_id,
    driver_name: shipment.driver_name,
    driver_phone: shipment.driver_phone,
    vehicle_plate: shipment.vehicle_plate,
    carton_count: String(shipment.carton_count),
    unit_count: String(shipment.unit_count),
    ship_on: shipment.ship_on,
    ship_to_address: shipment.ship_to_address,
    notes: shipment.notes,
  };
}

function inputOf(draft: Draft) {
  return {
    ...draft,
    carton_count: Number(draft.carton_count),
    unit_count: Number(draft.unit_count),
  };
}

/** Pesan WhatsApp untuk klien (pola v2.5b): resi atau identitas armada. */
function whatsappMessage(shipment: ShipmentRecord) {
  return [
    `Hello ${shipment.client_name ?? ""}, your order ${shipment.brand_name} has been shipped.`,
    `Delivery note: ${shipment.delivery_note_no}`,
    `Shipped by: ${shipmentCarrierLine(shipment)}`,
    `Shipping date: ${shipment.ship_on}`,
    `Cartons: ${shipment.carton_count}, units: ${shipment.unit_count}`,
  ].join("\n");
}

export function ShipmentSection({
  batch,
  shipments,
  carriers,
  storageSopText,
  shipBlock,
  onChanged,
}: {
  batch: BatchRecord;
  shipments: ShipmentRecord[];
  carriers: SupplierOption[];
  storageSopText: string;
  /** `shipGateError` work order ini; null = siap kirim. */
  shipBlock: string | null;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const canShip = hasPermission(user, "shipping.manage");
  const canForward = hasPermission(user, "samples.manage");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<{
    mode: "create" | "update";
    draft: Draft;
  } | null>(null);
  const [step, setStep] = useState<{
    action: ShipmentAction;
    tracking_no: string;
    reason: string;
    evidence_base64: string;
  } | null>(null);
  const isSubmittingRef = useRef(false);

  const active =
    shipments.find(
      (shipment) =>
        shipment.batch_id === batch.id && shipment.status !== "CANCELLED",
    ) ?? null;
  const activeCarriers = carriers.filter((option) => option.is_active === 1);

  const run = async (work: () => Promise<unknown>, after: () => void) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
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

  const download = async (work: () => Promise<string>) => {
    setError("");
    try {
      setNotice(await work());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PDF could not be saved.",
      );
    }
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    void run(
      () =>
        form.mode === "create"
          ? createShipment(batch.id, inputOf(form.draft))
          : recordShipmentStep(active?.id ?? "", {
              action: "SHIP_UPDATE",
              shipment: inputOf(form.draft),
              tracking_no: "",
              reason: "",
              evidence_base64: "",
            }),
      () => setForm(null),
    );
  };

  const submitStep = (event: FormEvent) => {
    event.preventDefault();
    if (!step || !active) return;
    void run(
      () => recordShipmentStep(active.id, { ...step, shipment: null }),
      () => setStep(null),
    );
  };

  const openStep = (action: ShipmentAction) =>
    setStep({ action, tracking_no: "", reason: "", evidence_base64: "" });

  const copyMessage = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(whatsappMessage(active));
      setNotice("Message copied. Paste it into WhatsApp.");
    } catch {
      setError("The message could not be copied.");
    }
  };

  const field = (
    key: keyof Draft,
    label: string,
    options: { type?: string; max?: number; required?: boolean } = {},
  ) =>
    form ? (
      <label className="app-label grid gap-1.5">
        {label}
        <input
          required={options.required ?? true}
          type={options.type ?? "text"}
          inputMode={options.type === "number" ? "numeric" : undefined}
          min={options.type === "number" ? 1 : undefined}
          maxLength={options.type ? undefined : options.max}
          max={options.type === "number" ? options.max : undefined}
          value={form.draft[key]}
          onChange={(event) =>
            setForm({
              ...form,
              draft: { ...form.draft, [key]: event.target.value },
            })
          }
          className="app-input font-normal"
        />
      </label>
    ) : null;

  return (
    <div className="grid gap-2">
      <h4 className="text-body-sm font-semibold text-on-surface">Shipment</h4>
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

      {!active && !form ? (
        <p className="text-body-sm text-on-surface-variant">
          {shipBlock
            ? `The delivery note is locked: ${shipBlock}`
            : "No delivery note yet."}
        </p>
      ) : null}
      {!active && !form && !shipBlock && canShip ? (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setForm({
                mode: "create",
                draft: {
                  method: "CARRIER",
                  carrier_option_id: "",
                  driver_name: "",
                  driver_phone: "",
                  vehicle_plate: "",
                  carton_count: String(batch.carton_count || ""),
                  unit_count: String(batch.produced_units || batch.total_units),
                  ship_on: deviceToday(),
                  ship_to_address: batch.ship_to_address ?? "",
                  notes: "",
                },
              })
            }
            className="app-btn app-btn-primary min-h-12"
          >
            Record shipment
          </button>
        </div>
      ) : null}

      {active && !form ? (
        <div className="grid gap-2 rounded-md border border-surface-container p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-body-md font-semibold text-on-surface">
              Delivery note{" "}
              <span className="font-mono">{active.delivery_note_no}</span>
            </span>
            <StatusBadge
              tone={active.status === "PREPARED" ? "info" : "success"}
            >
              {SHIPMENT_STATUS_LABEL[active.status] ?? active.status}
            </StatusBadge>
          </div>
          <p className="text-body-sm text-on-surface-variant">
            {shipmentCarrierLine(active)} · {active.carton_count} cartons,{" "}
            {active.unit_count.toLocaleString("en-US")} units · shipping{" "}
            {active.ship_on}
          </p>
          <p className="text-body-sm text-on-surface-variant">
            To {active.ship_to_address}
          </p>
          {active.notes ? (
            <p className="text-body-sm text-on-surface-variant">
              {active.notes}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void download(() => downloadDeliveryNote(active))}
              className="app-btn app-btn-secondary"
            >
              Delivery note PDF
            </button>
            {storageSopText ? (
              <button
                type="button"
                onClick={() =>
                  void download(() =>
                    downloadStorageSop(active, storageSopText),
                  )
                }
                className="app-btn app-btn-secondary"
              >
                Storage SOP PDF
              </button>
            ) : null}
          </div>

          {!step ? (
            <div className="flex flex-wrap gap-2">
              {canShip && active.status === "PREPARED" ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openStep("SHIP_DISPATCH")}
                    className="app-btn app-btn-primary min-h-12"
                  >
                    Mark shipped
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setForm({ mode: "update", draft: draftOf(active) })
                    }
                    className="app-btn app-btn-secondary"
                  >
                    Correct
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openStep("SHIP_CANCEL")}
                    className="app-btn app-btn-secondary"
                  >
                    Cancel delivery note
                  </button>
                </>
              ) : null}
              {canShip &&
              active.status !== "PREPARED" &&
              active.method === "CARRIER" &&
              !active.tracking_no ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openStep("SHIP_TRACKING")}
                  className="app-btn app-btn-primary"
                >
                  Add tracking number
                </button>
              ) : null}
              {canForward && active.status === "SHIPPED" ? (
                <>
                  <button
                    type="button"
                    onClick={() => void copyMessage()}
                    className="app-btn app-btn-secondary"
                  >
                    Copy WhatsApp message
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openStep("SHIP_FORWARD")}
                    className="app-btn app-btn-primary"
                  >
                    Mark sent to client
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <form onSubmit={submitStep} className="grid gap-3 sm:grid-cols-2">
              {step.action === "SHIP_DISPATCH" ||
              step.action === "SHIP_TRACKING" ? (
                <label className="app-label grid gap-1.5">
                  {step.action === "SHIP_TRACKING"
                    ? "Tracking number"
                    : "Tracking number (optional, can be added later)"}
                  <input
                    required={step.action === "SHIP_TRACKING"}
                    maxLength={TRACKING_NO_MAX}
                    value={step.tracking_no}
                    onChange={(event) =>
                      setStep({ ...step, tracking_no: event.target.value })
                    }
                    className="app-input font-normal"
                  />
                </label>
              ) : null}
              {step.action === "SHIP_DISPATCH" ? (
                <div className="sm:col-span-2">
                  <EvidencePicker
                    value={step.evidence_base64}
                    onChange={(value) =>
                      setStep({ ...step, evidence_base64: value })
                    }
                    label="Handover photo (optional)"
                    hint="A photo of the receipt or the goods on the truck."
                  />
                </div>
              ) : null}
              {step.action === "SHIP_CANCEL" ? (
                <label className="app-label grid gap-1.5 sm:col-span-2">
                  Why is the delivery note cancelled?
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
              ) : null}
              {step.action === "SHIP_FORWARD" ? (
                <p className="text-body-sm text-on-surface-variant sm:col-span-2">
                  Confirm that the client has the tracking number and the
                  delivery note.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="app-btn app-btn-primary min-h-12"
                >
                  {busy ? "Saving…" : "Confirm"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStep(null)}
                  className="app-btn app-btn-secondary min-h-12"
                >
                  Back
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}

      {form ? (
        <form
          onSubmit={submitForm}
          className="grid gap-3 rounded-md border border-surface-container p-3 sm:grid-cols-2"
        >
          <label className="app-label grid gap-1.5">
            Shipped by
            <select
              value={form.draft.method}
              onChange={(event) =>
                setForm({
                  ...form,
                  draft: {
                    ...form.draft,
                    method: event.target.value as DeliveryMethod,
                  },
                })
              }
              className="app-input font-normal"
            >
              <option value="CARRIER">Shipping company</option>
              <option value="FLEET">Own fleet</option>
            </select>
          </label>
          {form.draft.method === "CARRIER" ? (
            <label className="app-label grid gap-1.5">
              Shipping company
              <select
                required
                value={form.draft.carrier_option_id}
                onChange={(event) =>
                  setForm({
                    ...form,
                    draft: {
                      ...form.draft,
                      carrier_option_id: event.target.value,
                    },
                  })
                }
                className="app-input font-normal"
              >
                <option value="">Choose</option>
                {activeCarriers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {activeCarriers.length === 0 ? (
                <span className="text-body-sm font-normal text-on-surface-variant">
                  No shipping companies yet. Ask Admin to add them in Master
                  Data › Shipping companies.
                </span>
              ) : null}
            </label>
          ) : (
            <>
              {field("driver_name", "Driver", { max: 100 })}
              {field("vehicle_plate", "Vehicle plate", { max: 20 })}
              {field("driver_phone", "Driver phone (optional)", {
                max: 30,
                required: false,
              })}
            </>
          )}
          {field("carton_count", "Cartons", {
            type: "number",
            max: CARTON_COUNT_MAX,
          })}
          {field("unit_count", "Units", { type: "number" })}
          {field("ship_on", "Shipping date", { type: "date" })}
          <label className="app-label grid gap-1.5 sm:col-span-2">
            Deliver to
            <textarea
              required
              rows={2}
              maxLength={SHIP_ADDRESS_MAX}
              value={form.draft.ship_to_address}
              onChange={(event) =>
                setForm({
                  ...form,
                  draft: { ...form.draft, ship_to_address: event.target.value },
                })
              }
              className="app-input min-h-16 py-2 font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5 sm:col-span-2">
            Notes (optional)
            <input
              maxLength={PRODUCTION_REASON_MAX}
              value={form.draft.notes}
              onChange={(event) =>
                setForm({
                  ...form,
                  draft: { ...form.draft, notes: event.target.value },
                })
              }
              className="app-input font-normal"
            />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary min-h-12"
            >
              {busy
                ? "Saving…"
                : form.mode === "create"
                  ? "Issue delivery note"
                  : "Save correction"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setForm(null)}
              className="app-btn app-btn-secondary min-h-12"
            >
              Back
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
