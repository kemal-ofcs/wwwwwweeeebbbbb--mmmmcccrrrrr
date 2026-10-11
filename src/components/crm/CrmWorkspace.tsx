"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  assignCrm,
  type CrmClientRecord,
  type CrmOverview,
  getCrmOverview,
  repeatSampleOrder,
} from "@/lib/gateways/crm";
import {
  requestSyncNow,
  SYNC_COMPLETED_EVENT,
} from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import { onOpenDetail, requestedDetail } from "@/lib/utils/open-detail";
import { reorderDue } from "@/lib/validations/crm";

/**
 * Layar CRM (v3.6a, PRD F-29, D-49): klien yang sudah menyelesaikan order
 * pertamanya. Perkiraan repeat order dan seluruh isi kartu dihitung backend
 * (`CRM_CLIENT_LIST_SQL`); layar ini hanya memilah dan menetapkan PIC CRM.
 * Ditulis sekali untuk Web-Desktop dan Mobile (`filesToCopy`).
 */

type View = "due" | "unassigned" | "all";

function inView(row: CrmClientRecord, view: View) {
  if (view === "due") return reorderDue(row);
  if (view === "unassigned") return row.assigned_crm_id === null;
  return true;
}

export function CrmWorkspace() {
  const { user } = useAuth();
  const router = useRouter();
  const canAssign = hasPermission(user, "crm.manage");
  const [data, setData] = useState<CrmOverview>({ clients: [], operators: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>(() =>
    requestedDetail().tab === "due" ? "due" : "all",
  );
  const [search, setSearch] = useState("");
  /** Pilihan PIC per klien sebelum disimpan. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await getCrmOverview());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CRM could not load.");
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

  // Tautan lonceng saat halaman ini sudah terbuka.
  useEffect(
    () =>
      onOpenDetail(({ tab }) => {
        if (tab === "due") setView("due");
      }),
    [],
  );

  const counts = useMemo(
    () => ({
      due: data.clients.filter((row) => inView(row, "due")).length,
      unassigned: data.clients.filter((row) => inView(row, "unassigned"))
        .length,
      all: data.clients.length,
    }),
    [data.clients],
  );
  const term = search.trim().toLowerCase();
  const rows = data.clients.filter(
    (row) =>
      inView(row, view) &&
      (!term ||
        [row.client_code, row.client_name, row.brand_name, row.crm_name].some(
          (value) => value.toLowerCase().includes(term),
        )),
  );

  const assign = async (row: CrmClientRecord) => {
    const operatorId = Number(picks[row.id] ?? "");
    if (!operatorId || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await assignCrm(row.id, operatorId);
      setNotice(`${row.client_name} is now handled by the chosen CRM.`);
      await refresh();
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

  // Repeat order (v3.6b): tiket baru langsung Client approved, lalu MoU.
  const repeat = async (row: CrmClientRecord) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await repeatSampleOrder(row.last_sample_id);
      requestSyncNow();
      router.push(`/samples?id=${encodeURIComponent(created.id)}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The repeat order was not started.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="CRM"
        description="Clients who finished their first order: who looks after them and when they are due for a repeat order."
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div
          role="tablist"
          aria-label="CRM views"
          className="flex gap-1 overflow-x-auto border-b border-surface-container"
        >
          {(
            [
              ["due", "Due for reorder"],
              ["unassigned", "Unassigned"],
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
            placeholder="Client, brand, or CRM"
            className="app-input font-normal"
          />
        </label>
      </div>

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            {view === "due"
              ? "No client is due for a repeat order."
              : "No client has finished a first order yet. A client moves here once their goods are received, or their complaint is decided by QC."}
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {rows.map((row) => (
              <li key={row.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-body-md font-semibold text-on-surface">
                    {row.client_name}{" "}
                    <span className="font-mono text-body-sm font-normal text-on-surface-variant">
                      {row.client_code}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {row.open_tickets > 0 ? (
                      <StatusBadge tone="info">Order in progress</StatusBadge>
                    ) : reorderDue(row) ? (
                      <StatusBadge tone="warning">Due for reorder</StatusBadge>
                    ) : null}
                    {row.assigned_crm_id === null ? (
                      <StatusBadge tone="danger">No CRM yet</StatusBadge>
                    ) : null}
                  </span>
                </div>
                {row.last_sample_id === "" ? (
                  <p className="text-body-sm text-on-surface-variant">
                    History from the old sheets. Start the next order with a new
                    sample request.
                  </p>
                ) : null}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
                  <dt className="text-on-surface-variant">CRM</dt>
                  <dd className="text-on-surface">{row.crm_name || "-"}</dd>
                  <dt className="text-on-surface-variant">Last order</dt>
                  <dd className="text-on-surface">
                    {row.brand_name || "-"}
                    {row.packaging ? `, ${row.packaging}` : ""}
                    {row.last_units
                      ? `, ${row.last_units.toLocaleString("en-US")} units`
                      : ""}
                  </dd>
                  <dt className="text-on-surface-variant">Formula</dt>
                  <dd className="font-mono text-on-surface">
                    {row.last_formula_code || "-"}
                  </dd>
                  <dt className="text-on-surface-variant">Completed</dt>
                  <dd className="text-on-surface">
                    {row.last_completed_at
                      ? formatDateTime(row.last_completed_at)
                      : "-"}
                  </dd>
                  <dt className="text-on-surface-variant">Repeat around</dt>
                  <dd className="text-on-surface">{row.reorder_on || "-"}</dd>
                  <dt className="text-on-surface-variant">Last contact</dt>
                  <dd className="text-on-surface">
                    {row.last_contact_at
                      ? formatDateTime(row.last_contact_at)
                      : "-"}
                  </dd>
                </dl>
                <div className="flex flex-wrap items-end gap-2">
                  <Link
                    href={`/clients?id=${encodeURIComponent(row.id)}`}
                    className="app-btn app-btn-secondary"
                  >
                    Open client
                  </Link>
                  {canAssign && row.last_sample_id && row.open_tickets === 0 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void repeat(row)}
                      className="app-btn app-btn-primary"
                    >
                      Start repeat order
                    </button>
                  ) : null}
                  {canAssign ? (
                    <>
                      <label className="app-label grid gap-1.5">
                        CRM
                        <select
                          value={
                            picks[row.id] ?? String(row.assigned_crm_id ?? "")
                          }
                          onChange={(event) =>
                            setPicks({ ...picks, [row.id]: event.target.value })
                          }
                          className="app-input font-normal"
                        >
                          <option value="">Choose</option>
                          {data.operators.map((operator) => (
                            <option key={operator.id} value={operator.id}>
                              {operator.nama_operator}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          !picks[row.id] ||
                          Number(picks[row.id]) === row.assigned_crm_id
                        }
                        onClick={() => void assign(row)}
                        className="app-btn app-btn-secondary"
                      >
                        Assign
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
