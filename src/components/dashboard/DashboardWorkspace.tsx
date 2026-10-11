"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { buildXlsxWorkbook, exportFileName } from "@/lib/documents/xlsx";
import { type DashboardData, getDashboard } from "@/lib/gateways/dashboard";
import { saveXlsx } from "@/lib/gateways/documents";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import {
  type DashboardPreset,
  dashboardPeriod,
} from "@/lib/validations/dashboard";
import { formatRupiah } from "@/lib/validations/sample";
import { buildReportSheets } from "./report-workbook";

/**
 * Dashboard eksekutif (F-40a, D-52). Seluruh angka dihitung backend dari
 * data aplikasi (`DASHBOARD_*_SQL`); layar ini hanya memilih periode dan
 * menampilkan bagian yang izinnya dipegang. Ditulis sekali untuk
 * Web-Desktop dan Mobile (`filesToCopy`).
 */

type Period = DashboardPreset | "custom";

const PERIOD_LABEL: Record<Period, string> = {
  month: "This month",
  last_month: "Last month",
  quarter: "This quarter",
  year: "This year",
  custom: "Custom range",
};

function deviceToday() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function count(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function average(value: number | null | undefined, unit: string) {
  return value === null || value === undefined ? "-" : `${value} ${unit}`;
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-surface-container p-3">
      <p className="text-body-sm text-on-surface-variant">{label}</p>
      <p className="text-headline-lg font-bold text-on-surface">{value}</p>
      {hint ? (
        <p className="text-body-sm text-on-surface-variant">{hint}</p>
      ) : null}
    </div>
  );
}

/** Tahapan berurutan sebagai batang horizontal relatif terhadap yang terbesar. */
function Funnel({ steps }: { steps: [string, number][] }) {
  const top = Math.max(1, ...steps.map(([, value]) => value));
  return (
    <ol className="grid gap-2">
      {steps.map(([label, value]) => (
        <li key={label} className="grid gap-1">
          <div className="flex justify-between text-body-sm">
            <span className="text-on-surface">{label}</span>
            <span className="font-semibold text-on-surface">
              {count(value)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-container">
            <div
              className="h-2 rounded-full bg-secondary"
              style={{ width: `${(value / top) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="app-panel grid gap-3 p-4">
      <h2 className="text-headline-md font-semibold text-on-surface">
        {title}
      </h2>
      {children}
    </section>
  );
}

const GRID = "grid grid-cols-2 gap-3 md:grid-cols-4";

export function DashboardWorkspace() {
  const { user } = useAuth();
  const canExport = hasPermission(user, "data.export");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const isSubmittingRef = useRef(false);
  const [period, setPeriod] = useState<Period>("month");
  const [range, setRange] = useState(() =>
    dashboardPeriod("month", deviceToday()),
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await getDashboard(range.from, range.to));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The dashboard could not load.",
      );
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
    const onSync = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSync);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSync);
  }, [refresh]);

  // Workbook laporan periode ini (F-40b): `data.export`, tercatat di audit.
  const download = async () => {
    if (!data || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const report = await buildReportSheets(user, data);
      const saved = await saveXlsx(
        exportFileName("report"),
        buildXlsxWorkbook(report.sheets),
        "export",
        "report",
        report.rows,
      );
      setNotice(
        saved.path
          ? `Saved to ${saved.path}`
          : saved.savedToDevice
            ? `Report saved with ${report.sheets.length} sheets.`
            : "",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The report was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setExporting(false);
    }
  };

  const choose = (next: Period) => {
    setPeriod(next);
    if (next !== "custom") setRange(dashboardPeriod(next, deviceToday()));
  };

  const sales = data?.sections.sales;
  const samples = data?.sections.samples;
  const finance = data?.sections.finance;
  const production = data?.sections.production;
  const crm = data?.sections.crm;
  const empty =
    data !== null && !sales && !samples && !finance && !production && !crm;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description={
          isDesktopRuntime()
            ? "Figures for the chosen period, from this device's data as of the last sync."
            : "Figures for the chosen period, calculated from the app's data."
        }
        actions={
          canExport ? (
            <button
              type="button"
              disabled={exporting || !data}
              onClick={() => void download()}
              className="app-btn app-btn-secondary"
            >
              {exporting ? "Preparing…" : "Download report"}
            </button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="app-label grid gap-1.5">
          Period
          <select
            value={period}
            onChange={(event) => choose(event.target.value as Period)}
            className="app-input font-normal"
          >
            {(Object.keys(PERIOD_LABEL) as Period[]).map((value) => (
              <option key={value} value={value}>
                {PERIOD_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        {period === "custom" ? (
          <>
            <label className="app-label grid gap-1.5">
              From
              <input
                type="date"
                value={range.from}
                onChange={(event) =>
                  setRange({ ...range, from: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              To
              <input
                type="date"
                value={range.to}
                onChange={(event) =>
                  setRange({ ...range, to: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
          </>
        ) : (
          <p className="pb-2 text-body-sm text-on-surface-variant">
            {range.from} to {range.to}
          </p>
        )}
      </div>

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
      {loading ? (
        <p className="text-body-md text-on-surface-variant">Loading…</p>
      ) : null}
      {empty ? (
        <p className="app-panel p-4 text-body-md text-on-surface-variant">
          Your role has no dashboard sections. Ask the Superadmin if you need
          sales, finance, or production figures.
        </p>
      ) : null}

      {sales || samples || crm ? (
        <Section title="Sales">
          <Funnel
            steps={[
              ...(sales
                ? ([["New leads", sales.leads_new]] as [string, number][])
                : []),
              ...(samples
                ? ([
                    ["New sample requests", samples.samples_new],
                    [
                      "Samples approved by the client",
                      samples.samples_approved,
                    ],
                    ["MoUs accepted", samples.mou_accepted],
                  ] as [string, number][])
                : []),
              ...(crm
                ? ([["Orders completed", crm.orders_completed]] as [
                    string,
                    number,
                  ][])
                : []),
            ]}
          />
          {sales ? (
            <div className={GRID}>
              <Tile
                label="Open leads"
                value={count(sales.leads_open)}
                hint={`${count(sales.leads_hot)} hot, ${count(sales.leads_warm)} warm, ${count(sales.leads_cold)} cold`}
              />
              <Tile
                label="Leads without a PIC"
                value={count(sales.leads_without_pic)}
                hint="Target 0"
              />
              <Tile
                label="Lead to first sample"
                value={average(sales.avg_lead_to_sample_days, "days")}
                hint="Average, target 7 days or less"
              />
            </div>
          ) : null}
          {samples ? (
            <div className={GRID}>
              <Tile label="Samples sent" value={count(samples.samples_sent)} />
              <Tile
                label="Sample requests in progress"
                value={count(samples.samples_in_progress)}
              />
              <Tile
                label="RnD turnaround"
                value={average(samples.avg_rnd_days, "days")}
                hint="Average, target 5 days or less"
              />
            </div>
          ) : null}
        </Section>
      ) : null}

      {finance ? (
        <Section title="Finance">
          <div className={GRID}>
            <Tile
              label="Invoiced"
              value={formatRupiah(finance.invoiced_idr)}
              hint={`${count(finance.invoices_issued)} invoices, installments excluded`}
            />
            <Tile
              label="Money received"
              value={formatRupiah(finance.received_idr)}
            />
            <Tile
              label="Outstanding"
              value={formatRupiah(finance.outstanding_idr)}
              hint="All open invoices today"
            />
            <Tile
              label="Overdue"
              value={formatRupiah(finance.overdue_idr)}
              hint={`${count(finance.overdue_count)} invoices past due`}
            />
            <Tile
              label="Not yet allocated"
              value={formatRupiah(finance.unallocated_idr)}
              hint="Incoming payments not matched to an invoice"
            />
          </div>
        </Section>
      ) : null}

      {production ? (
        <Section title="Production and delivery">
          <div className={GRID}>
            <Tile
              label="Work orders waiting to start"
              value={count(production.wo_waiting)}
            />
            <Tile label="On the floor" value={count(production.wo_floor)} />
            <Tile
              label="Packed, not shipped"
              value={count(production.wo_packed)}
            />
            <Tile
              label="Packed on schedule"
              value={
                production.packed === 0
                  ? "-"
                  : `${Math.round((production.packed_on_time / production.packed) * 100)}%`
              }
              hint={`${count(production.packed_on_time)} of ${count(production.packed)} packed, target 90%`}
            />
            <Tile
              label="Behind schedule"
              value={count(production.behind_schedule)}
            />
            <Tile
              label="Late purchase orders"
              value={count(production.late_purchase_orders)}
            />
            <Tile label="Shipped" value={count(production.shipped)} />
            <Tile
              label="Received in good condition"
              value={count(production.received_ok)}
            />
            <Tile
              label="Complaints"
              value={count(production.complaints)}
              hint={`${count(production.claims_open)} still open`}
            />
            <Tile
              label="QC decisions"
              value={count(production.claims_decided)}
              hint={`${count(production.claims_internal)} our fault`}
            />
            <Tile
              label="QC decision time"
              value={average(production.avg_qc_hours, "hours")}
              hint="Average, target 48 hours or less"
            />
          </div>
        </Section>
      ) : null}

      {crm ? (
        <Section title="CRM">
          <div className={GRID}>
            <Tile label="CRM clients" value={count(crm.crm_clients)} />
            <Tile label="Without a CRM" value={count(crm.crm_unassigned)} />
            <Tile label="Due for reorder" value={count(crm.crm_due)} />
            <Tile
              label="Repeat orders started"
              value={count(crm.repeat_started)}
            />
          </div>
        </Section>
      ) : null}
    </div>
  );
}
