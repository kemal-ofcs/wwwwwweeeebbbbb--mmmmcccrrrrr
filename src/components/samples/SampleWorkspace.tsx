"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type ClientRecord,
  listClients,
  listMasterOptions,
  listOperatorDirectory,
  type MasterOptionRecord,
  type OperatorDirectoryEntry,
} from "@/lib/gateways/clients";
import {
  listSampleRequests,
  type SampleDraftInput,
  type SampleFeeMode,
  type SampleRequestRecord,
} from "@/lib/gateways/samples";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import {
  SAMPLE_TERMINAL_STATUSES,
  type SampleStatus,
} from "@/lib/validations/sample";
import {
  SAMPLE_STATUS_LABEL,
  SAMPLE_STATUS_TONE,
  timeInStatus,
} from "./labels";
import { SampleDetail } from "./SampleDetail";
import { SampleForm } from "./SampleForm";

/**
 * Workspace tiket sampel (PRD F-06, SCR-03). Ditulis sekali untuk Web-Desktop
 * dan Mobile (`filesToCopy`). `?client=<id>` membuka form tiket baru untuk
 * klien itu (tombol dari panel lead).
 */

type View = "active" | "closed" | "all";

function emptyDraft(clientId: string, client?: ClientRecord): SampleDraftInput {
  return {
    id: "",
    client_id: clientId,
    product_category_option_id: client?.product_category_option_id ?? "",
    sample_kind_option_id: "",
    formulation_type_option_id: "",
    registration_category_option_id: "",
    pic_crm_id: null,
    sample_qty: 1,
    brand_name: "",
    bpom_product_name: "",
    claims: "",
    packaging: "",
    reference_notes: "",
    client_budget_idr: null,
    special_requests: { color: "", texture: "", size: "", aroma: "" },
    deadline_at: "",
    ship_to_address: client
      ? [client.address, client.city, client.province]
          .filter(Boolean)
          .join(", ")
      : "",
    is_dummy_required: false,
    is_paid_sample: null,
  };
}

function draftOf(row: SampleRequestRecord): SampleDraftInput {
  let special = { color: "", texture: "", size: "", aroma: "" };
  try {
    special = { ...special, ...JSON.parse(row.special_requests_json) };
  } catch {
    // Isian rusak tampil kosong; backend tetap memvalidasi saat disimpan.
  }
  return {
    id: row.id,
    client_id: row.client_id,
    product_category_option_id: row.product_category_option_id,
    sample_kind_option_id: row.sample_kind_option_id,
    formulation_type_option_id: row.formulation_type_option_id,
    registration_category_option_id: row.registration_category_option_id,
    pic_crm_id: row.pic_crm_id,
    sample_qty: row.sample_qty,
    brand_name: row.brand_name,
    bpom_product_name: row.bpom_product_name,
    claims: row.claims,
    packaging: row.packaging,
    reference_notes: row.reference_notes,
    client_budget_idr: row.client_budget_idr,
    special_requests: special,
    deadline_at: row.deadline_at,
    ship_to_address: row.ship_to_address,
    is_dummy_required: row.is_dummy_required === 1,
    is_paid_sample: row.is_paid_sample === 1,
  };
}

export function SampleWorkspace() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "samples.manage");
  const [requests, setRequests] = useState<SampleRequestRecord[]>([]);
  const [feeMode, setFeeMode] = useState<SampleFeeMode>("PER_REQUEST");
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [options, setOptions] = useState<MasterOptionRecord[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<{
    draft: SampleDraftInput;
    locked: boolean;
  } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSampleRequests();
      setRequests(list.requests);
      setFeeMode(list.sample_fee_mode);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Sample requests could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Pilihan form: gagal dibaca = form menampilkan daftar kosong.
    void listMasterOptions()
      .then(setOptions)
      .catch(() => setOptions([]));
    void listOperatorDirectory()
      .then(setOperators)
      .catch(() => setOperators([]));
    void listClients()
      .then((rows) => {
        setClients(rows);
        const requested = new URLSearchParams(window.location.search).get(
          "client",
        );
        if (requested && canManage) {
          const client = rows.find((row) => row.id === requested);
          if (client)
            setForm({ draft: emptyDraft(client.id, client), locked: false });
        }
      })
      .catch(() => setClients([]));
    const onSync = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSync);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSync);
  }, [refresh, canManage]);

  const labels = useMemo(
    () => new Map(options.map((option) => [option.id, option.label])),
    [options],
  );
  const optionLabel = (id: string) =>
    id ? (labels.get(id) ?? "Unknown option") : "";

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return requests.filter((row) => {
      const closed = SAMPLE_TERMINAL_STATUSES.includes(
        row.status as SampleStatus,
      );
      if (view === "active" && closed) return false;
      if (view === "closed" && !closed) return false;
      if (!term) return true;
      return [
        row.brand_name,
        row.client_code ?? "",
        row.client_name ?? "",
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [requests, view, search]);

  const detail = requests.find((row) => row.id === detailId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Samples"
        description="Sample requests from first brief to the client's decision, with the free revision quota of each client."
        actions={
          canManage ? (
            <button
              type="button"
              onClick={() => setForm({ draft: emptyDraft(""), locked: false })}
              className="app-btn app-btn-primary"
            >
              New sample request
            </button>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div
          role="tablist"
          aria-label="Sample views"
          className="flex gap-1 border-b border-surface-container"
        >
          {(
            [
              ["active", "In progress"],
              ["closed", "Closed"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => setView(value)}
              className={`-mb-px min-h-11 border-b-2 px-3 text-body-md font-semibold ${
                view === value
                  ? "border-primary text-on-surface"
                  : "border-transparent text-on-surface-variant"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="app-label grid flex-1 gap-1.5 sm:max-w-sm">
          Search
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Brand, client code, or client name"
            className="app-input font-normal"
          />
        </label>
      </div>

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            {requests.length === 0
              ? "No sample requests yet. Open a lead on the Clients page, or use New sample request."
              : "No sample request matches."}
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {visible.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setDetailId(row.id)}
                  className="flex w-full flex-col gap-1 p-4 text-left hover:bg-surface-container-low sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-body-md font-semibold text-on-surface">
                        {row.brand_name}
                      </span>
                      <StatusBadge
                        tone={SAMPLE_STATUS_TONE[row.status] ?? "neutral"}
                      >
                        {SAMPLE_STATUS_LABEL[row.status] ?? row.status}
                      </StatusBadge>
                      {row.revision_index > 0 ? (
                        <span className="text-body-sm text-on-surface-variant">
                          Revision {row.revision_index}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-body-sm text-on-surface-variant">
                      <span className="font-mono">{row.client_code}</span> ·{" "}
                      {row.client_name} ·{" "}
                      {optionLabel(row.product_category_option_id)}
                    </span>
                  </span>
                  <span className="shrink-0 text-body-sm text-on-surface-variant sm:text-right">
                    <span className="block">Deadline {row.deadline_at}</span>
                    <span className="block">
                      {timeInStatus(row.status_changed_at)} in this status
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail ? (
        <SampleDetail
          id={detail.id}
          optionLabel={optionLabel}
          canManage={canManage}
          onEdit={() => {
            setDetailId(null);
            setForm({
              draft: draftOf(detail),
              locked: detail.status !== "DRAFT",
            });
          }}
          onChanged={refresh}
          onClose={() => setDetailId(null)}
        />
      ) : null}

      {form ? (
        <SampleForm
          draft={form.draft}
          clients={clients}
          options={options}
          operators={operators}
          feeMode={feeMode}
          locked={form.locked}
          onSaved={(id) => {
            const created = form.draft.id === "";
            setForm(null);
            void refresh().then(() => {
              setNotice(
                created ? "Sample request created." : "Sample request updated.",
              );
              if (created) setDetailId(id);
            });
          }}
          onClose={() => setForm(null)}
        />
      ) : null}
    </div>
  );
}
