"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MATERIAL_STATUS_LABEL,
  MATERIAL_STATUS_TONE,
} from "@/components/samples/labels";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  getProductionOverview,
  type ProductionOverview,
} from "@/lib/gateways/production";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { ProductionPanel } from "./ProductionPanel";

/**
 * Halaman Production (v3.1, PRD F-23/F-24, SCR-15): MoU yang siap dibuatkan
 * work order, lalu work order per tahap bahan dan jadwal. Ditulis sekali untuk
 * Web-Desktop dan Mobile (`filesToCopy`).
 */

type View = "ready" | "materials" | "scheduling" | "scheduled" | "all";

const EMPTY: ProductionOverview = {
  ready: [],
  batches: [],
  purchase_orders: [],
  suppliers: [],
};

export function ProductionWorkspace() {
  const [data, setData] = useState<ProductionOverview>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("ready");
  const [search, setSearch] = useState("");
  /** `mou:<id>` untuk MoU tanpa work order, `batch:<id>` untuk work order. */
  const [openKey, setOpenKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await getProductionOverview());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Production could not load.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onSync = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSync);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSync);
  }, [refresh]);

  const counts = useMemo(
    () => ({
      ready: data.ready.length,
      materials: data.batches.filter((b) => b.material_status !== "READY")
        .length,
      scheduling: data.batches.filter(
        (b) => b.sched_packing_on === "" || b.needs_reschedule === 1,
      ).length,
      scheduled: data.batches.filter(
        (b) => b.sched_packing_on !== "" && b.needs_reschedule !== 1,
      ).length,
      all: data.batches.length,
    }),
    [data],
  );

  const query = search.trim().toLowerCase();
  const matches = (...values: (string | null)[]) =>
    !query || values.some((value) => value?.toLowerCase().includes(query));
  const ready = data.ready.filter((mou) =>
    matches(mou.mou_number, mou.brand_name, mou.client_code, mou.client_name),
  );
  const batches = data.batches.filter((batch) => {
    if (
      !matches(
        batch.batch_code,
        batch.brand_name,
        batch.client_code,
        batch.client_name,
      )
    )
      return false;
    if (view === "materials") return batch.material_status !== "READY";
    if (view === "scheduling")
      return batch.sched_packing_on === "" || batch.needs_reschedule === 1;
    if (view === "scheduled")
      return batch.sched_packing_on !== "" && batch.needs_reschedule !== 1;
    return true;
  });

  const openMou = openKey?.startsWith("mou:")
    ? (data.ready.find((mou) => `mou:${mou.id}` === openKey) ?? null)
    : null;
  const openBatch = openKey?.startsWith("batch:")
    ? (data.batches.find((batch) => `batch:${batch.id}` === openKey) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Production"
        description="Work orders from accepted MoUs: materials, purchase orders, and the production schedule."
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div
          role="tablist"
          aria-label="Production views"
          className="flex gap-1 overflow-x-auto border-b border-surface-container"
        >
          {(
            [
              ["ready", "Ready for PPIC"],
              ["materials", "Materials"],
              ["scheduling", "To schedule"],
              ["scheduled", "Scheduled"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => setView(value)}
              className={`-mb-px min-h-11 shrink-0 border-b-2 px-3 text-body-md font-semibold ${
                view === value
                  ? "border-primary text-on-surface"
                  : "border-transparent text-on-surface-variant"
              }`}
            >
              {label} ({counts[value]})
            </button>
          ))}
        </div>
        <label className="app-label grid flex-1 gap-1.5 sm:max-w-sm">
          Search
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Work order, brand, or client"
            className="app-input font-normal"
          />
        </label>
      </div>

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : view === "ready" ? (
          ready.length === 0 ? (
            <p className="p-4 text-body-md text-on-surface-variant">
              No accepted MoU is waiting for a work order. A MoU appears here
              once the client accepts it and the down payment is paid.
            </p>
          ) : (
            <ul className="divide-y divide-surface-container">
              {ready.map((mou) => (
                <li key={mou.id}>
                  <button
                    type="button"
                    onClick={() => setOpenKey(`mou:${mou.id}`)}
                    className="flex w-full flex-col gap-1 p-4 text-left hover:bg-surface-container-low"
                  >
                    <span className="text-body-md font-semibold text-on-surface">
                      {mou.brand_name}
                    </span>
                    <span className="text-body-sm text-on-surface-variant">
                      <span className="font-mono">{mou.mou_number}</span> ·{" "}
                      <span className="font-mono">{mou.client_code}</span> ·{" "}
                      {mou.client_name} ·{" "}
                      {mou.total_units.toLocaleString("en-US")} units
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : batches.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            No work order matches.
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {batches.map((batch) => (
              <li key={batch.id}>
                <button
                  type="button"
                  onClick={() => setOpenKey(`batch:${batch.id}`)}
                  className="flex w-full flex-col gap-1 p-4 text-left hover:bg-surface-container-low sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-body-md font-semibold text-on-surface">
                        {batch.brand_name}
                      </span>
                      <StatusBadge
                        tone={MATERIAL_STATUS_TONE[batch.material_status]}
                      >
                        {MATERIAL_STATUS_LABEL[batch.material_status] ??
                          batch.material_status}
                      </StatusBadge>
                      {batch.needs_reschedule === 1 ? (
                        <StatusBadge tone="warning">Reschedule</StatusBadge>
                      ) : null}
                    </span>
                    <span className="block text-body-sm text-on-surface-variant">
                      <span className="font-mono">{batch.batch_code}</span> ·{" "}
                      <span className="font-mono">{batch.client_code}</span> ·{" "}
                      {batch.client_name}
                    </span>
                  </span>
                  <span className="shrink-0 text-body-sm text-on-surface-variant sm:text-right">
                    <span className="block">
                      {batch.sched_packing_on
                        ? `Packing ${batch.sched_packing_on}`
                        : "Not scheduled"}
                    </span>
                    {batch.open_orders > 0 ? (
                      <span className="block">
                        {batch.open_orders} open PO, next arrival{" "}
                        {batch.next_eta_on}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openKey && (openMou || openBatch) ? (
        <Modal
          title={
            openBatch
              ? `${openBatch.brand_name} · ${openBatch.client_code ?? ""}`
              : `${openMou?.brand_name ?? ""} · ${openMou?.client_code ?? ""}`
          }
          titleId="production-detail-title"
          onClose={() => setOpenKey(null)}
        >
          <ProductionPanel
            mou={openMou}
            batch={openBatch}
            purchaseOrders={data.purchase_orders}
            suppliers={data.suppliers}
            onChanged={() => {
              // Work order baru menggantikan baris MoU-nya di daftar.
              void refresh().then(() => {
                if (!openMou) return;
                setOpenKey(null);
                setView("materials");
              });
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}
