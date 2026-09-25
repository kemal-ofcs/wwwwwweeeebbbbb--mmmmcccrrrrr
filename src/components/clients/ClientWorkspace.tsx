"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { describeDays, LeadDetail } from "@/components/clients/LeadDetail";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type ClientDraft,
  type ClientRecord,
  getClientCodeSettings,
  listClients,
  listMasterOptions,
  type MasterOptionRecord,
  registerClient,
  updateClient,
} from "@/lib/gateways/clients";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import {
  CLIENT_NAME_MAX,
  CLIENT_NOTES_MAX,
  CLIENT_TEXT_MAX,
  type LeadSegment,
} from "@/lib/validations/client";

/**
 * Workspace CS: pipeline lead, Antrian Cold, dan form intake (PRD FR-04,
 * FR-05; mockup SCR-01 dan SCR-02). Pertanyaan yang dijawab layar ini: lead
 * mana yang harus dihubungi sekarang. Segmen dihitung backend.
 *
 * Ditulis sekali dan dipakai halaman `/clients` Web-Desktop maupun Mobile
 * (`filesToCopy`); kerangka layarnya (`AppShell` / `MobileAppShell`) dan guard
 * halaman tetap milik masing-masing halaman. Semua aturan (normalisasi nomor,
 * nomor ganda, pilihan aktif, kode klien) diputuskan backend; form ini hanya
 * mengumpulkan isian dan menampilkan penolakannya.
 */

const EMPTY_DRAFT: ClientDraft = {
  name: "",
  phone: "",
  address: "",
  city: "",
  province: "",
  channel_option_id: "",
  product_category_option_id: "",
  needs_notes: "",
};

const SEGMENT_TONE: Record<LeadSegment, StatusTone> = {
  HOT: "success",
  WARM: "warning",
  COLD: "neutral",
};

type Tab = "pipeline" | "cold";

const LIFECYCLE_LABEL: Record<string, string> = {
  LEAD: "Lead",
  FIRST_ORDER_ACTIVE: "First order",
  EXISTING_CLIENT: "Existing client",
};

function draftOf(client: ClientRecord): ClientDraft {
  return {
    name: client.name,
    phone: client.phone_normalized,
    address: client.address,
    city: client.city,
    province: client.province,
    channel_option_id: client.channel_option_id,
    product_category_option_id: client.product_category_option_id,
    needs_notes: client.needs_notes,
  };
}

function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function ClientWorkspace() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "clients.manage");
  const canManageMasterData = hasPermission(user, "master_data.manage");
  const canViewLeads = hasPermission(user, "leads.view");
  const canManageLeads = hasPermission(user, "leads.manage");
  const canReassign = hasPermission(user, "leads.reassign");

  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [options, setOptions] = useState<MasterOptionRecord[]>([]);
  const [deviceTag, setDeviceTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("pipeline");
  const [categoryFilter, setCategoryFilter] = useState("");
  /** `""` = semua PIC, `"mine"` = milik saya, selain itu id operator. */
  const [picFilter, setPicFilter] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  /** `null` = form tertutup, `""` = klien baru, selain itu id klien yang disunting. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ClientDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // Ref, bukan state: dua klik dalam satu tick sama-sama membaca state lama,
  // dan klik ganda di sini berarti dua lead untuk satu klien.
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [clientRows, optionRows, codeSettings] = await Promise.all([
        listClients(),
        listMasterOptions(),
        getClientCodeSettings(),
      ]);
      setClients(clientRows);
      setOptions(optionRows);
      setDeviceTag(codeSettings.device_tag);
      setError("");
    } catch (cause) {
      setError(errorText(cause, "Clients could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Klien dari perangkat lain tiba lewat siklus sinkronisasi, bukan lewat aksi
  // di layar ini; tanpa listener ini daftarnya baru berubah setelah dimuat ulang.
  useEffect(() => {
    const onSynced = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSynced);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSynced);
  }, [refresh]);

  const optionLabel = useMemo(() => {
    const labels = new Map(options.map((option) => [option.id, option.label]));
    return (id: string) => labels.get(id) ?? "-";
  }, [options]);

  /**
   * Pilihan untuk form: yang aktif, ditambah nilai yang sedang tersimpan pada
   * klien yang disunting walau sudah dinonaktifkan (FR-12.3).
   */
  const choices = (kind: string, current: string) =>
    options.filter(
      (option) =>
        option.kind === kind && (option.is_active || option.id === current),
    );

  const pics = useMemo(() => {
    const seen = new Map<number, string>();
    for (const client of clients) {
      if (client.pic_cs_id != null && !seen.has(client.pic_cs_id)) {
        seen.set(
          client.pic_cs_id,
          client.pic_cs_name ?? `#${client.pic_cs_id}`,
        );
      }
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [clients]);

  const coldCount = useMemo(
    () => clients.filter((client) => client.segment === "COLD").length,
    [clients],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const digits = term.replace(/\D/g, "");
    const rows = clients.filter((client) => {
      if (tab === "cold" && client.segment !== "COLD") return false;
      if (
        categoryFilter &&
        client.product_category_option_id !== categoryFilter
      ) {
        return false;
      }
      if (picFilter === "mine" && client.pic_cs_id !== user?.id) return false;
      if (
        picFilter &&
        picFilter !== "mine" &&
        String(client.pic_cs_id) !== picFilter
      ) {
        return false;
      }
      if (!term) return true;
      return (
        client.name.toLowerCase().includes(term) ||
        client.client_code.toLowerCase().includes(term) ||
        client.city.toLowerCase().includes(term) ||
        (digits.length >= 3 && client.phone_normalized.includes(digits))
      );
    });
    // Antrian Cold: yang paling lama diam di atas (PRD FR-05.6).
    if (tab === "cold") {
      rows.sort(
        (a, b) => (b.days_since_response ?? 0) - (a.days_since_response ?? 0),
      );
    }
    return rows;
  }, [clients, search, tab, categoryFilter, picFilter, user?.id]);

  const detailClient = detailId
    ? (clients.find((client) => client.id === detailId) ?? null)
    : null;

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setFormError("");
    setEditingId("");
  };

  const openEdit = (client: ClientRecord) => {
    setDraft(draftOf(client));
    setFormError("");
    setEditingId(client.id);
  };

  const closeForm = () => {
    if (isSubmittingRef.current) return;
    setEditingId(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current || editingId === null) return;
    isSubmittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      let message = "Client updated.";
      if (editingId) {
        await updateClient(editingId, draft);
      } else {
        const saved = await registerClient(draft);
        message = `Lead registered as ${saved.client_code}.`;
      }
      setEditingId(null);
      // Tanda berhasil baru muncul setelah daftar memuat data baru, supaya
      // pengguna tidak melihat "berhasil" di samping nilai lama.
      await refresh();
      setNotice(message);
    } catch (cause) {
      setFormError(errorText(cause, "The client could not be saved."));
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  const channelChoices = choices("LEAD_CHANNEL", draft.channel_option_id);
  const categoryChoices = choices(
    "PRODUCT_CATEGORY",
    draft.product_category_option_id,
  );
  // Perangkat tanpa tag belum bisa membuat kode klien (PRD FR-04.5). Web
  // memakai tag Web dari Pengaturan, jadi pemeriksaan ini hanya untuk perangkat.
  const needsDeviceTag = isDesktopRuntime() && !loading && !deviceTag;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clients"
        description="Every lead starts here. A client stays a lead until the first sample ticket is created."
        actions={
          canManage ? (
            <button
              type="button"
              onClick={openNew}
              disabled={needsDeviceTag}
              className="app-btn app-btn-primary w-full sm:w-auto"
            >
              <Icon name="plus" className="size-4" />
              New lead
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
      {canManage && needsDeviceTag ? (
        <FeedbackBanner tone="warning">
          Connect this device to the database once to get its device code. New
          leads can be registered after that.
        </FeedbackBanner>
      ) : null}

      {canViewLeads ? (
        <div
          role="tablist"
          aria-label="Lead views"
          className="flex gap-1 border-b border-surface-container"
        >
          {(
            [
              ["pipeline", "Pipeline"],
              ["cold", `Cold queue (${coldCount})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
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
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <label className="app-label grid gap-1.5">
          Search
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, client code, city, or WhatsApp number"
            className="app-input font-normal"
          />
        </label>
        <label className="app-label grid gap-1.5">
          Category
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            className="app-input font-normal"
          >
            <option value="">All categories</option>
            {options
              .filter((option) => option.kind === "PRODUCT_CATEGORY")
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
          </select>
        </label>
        <label className="app-label grid gap-1.5">
          CS
          <select
            value={picFilter}
            onChange={(event) => setPicFilter(event.target.value)}
            className="app-input font-normal"
          >
            <option value="">Everyone</option>
            <option value="mine">My leads</option>
            {pics.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            {clients.length === 0
              ? "No clients yet. Register the first lead to get started."
              : tab === "cold" && !search && !categoryFilter && !picFilter
                ? "No cold leads. Every lead has responded in the last 7 days."
                : "No client matches these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {filtered.map((client) => (
              <li key={client.id}>
                <button
                  type="button"
                  onClick={() => setDetailId(client.id)}
                  className="flex w-full flex-col gap-1 p-4 text-left hover:bg-surface-container-low sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-body-md font-semibold text-on-surface">
                        {client.name}
                      </span>
                      {client.segment ? (
                        <StatusBadge tone={SEGMENT_TONE[client.segment]}>
                          {client.segment}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="info">
                          {LIFECYCLE_LABEL[client.lifecycle_status] ??
                            client.lifecycle_status}
                        </StatusBadge>
                      )}
                    </span>
                    <span className="block text-body-sm text-on-surface-variant">
                      <span className="font-mono">{client.client_code}</span> ·{" "}
                      {optionLabel(client.product_category_option_id)}
                      {client.city ? ` · ${client.city}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-body-sm text-on-surface-variant sm:text-right">
                    <span className="block">
                      Responded {describeDays(client.days_since_response)}
                    </span>
                    <span className="block">
                      {client.pic_cs_name ??
                        (client.pic_cs_id
                          ? `CS #${client.pic_cs_id}`
                          : "No CS")}{" "}
                      · {client.total_followups} follow up
                      {client.total_followups === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detailClient ? (
        <LeadDetail
          client={detailClient}
          optionLabel={optionLabel}
          canRecord={
            canManageLeads &&
            (detailClient.pic_cs_id === user?.id || canReassign)
          }
          canReassign={canReassign}
          canEditClient={canManage}
          onEditClient={() => {
            setDetailId(null);
            openEdit(detailClient);
          }}
          onChanged={refresh}
          onClose={() => setDetailId(null)}
        />
      ) : null}

      {editingId !== null ? (
        <Modal
          title={editingId ? "Edit client" : "New lead"}
          titleId="client-form-title"
          onClose={closeForm}
        >
          <form className="space-y-4" onSubmit={submit}>
            {formError ? (
              <FeedbackBanner tone="error">{formError}</FeedbackBanner>
            ) : null}

            <label className="app-label grid gap-1.5">
              Client name
              <input
                required
                minLength={2}
                maxLength={CLIENT_NAME_MAX}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              WhatsApp number
              <input
                required
                type="tel"
                inputMode="tel"
                value={draft.phone}
                onChange={(event) =>
                  setDraft({ ...draft, phone: event.target.value })
                }
                placeholder="0812 3456 7890"
                className="app-input font-normal"
              />
            </label>

            <OptionSelect
              id="client-channel"
              label="Lead channel"
              kindLabel="lead channels"
              value={draft.channel_option_id}
              options={channelChoices}
              canManageMasterData={canManageMasterData}
              onChange={(value) =>
                setDraft({ ...draft, channel_option_id: value })
              }
            />
            <OptionSelect
              id="client-category"
              label="Product category"
              kindLabel="product categories"
              value={draft.product_category_option_id}
              options={categoryChoices}
              canManageMasterData={canManageMasterData}
              onChange={(value) =>
                setDraft({ ...draft, product_category_option_id: value })
              }
            />

            <label className="app-label grid gap-1.5">
              Address
              <input
                maxLength={CLIENT_TEXT_MAX}
                value={draft.address}
                onChange={(event) =>
                  setDraft({ ...draft, address: event.target.value })
                }
                className="app-input font-normal"
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="app-label grid gap-1.5">
                City / regency
                <input
                  maxLength={CLIENT_TEXT_MAX}
                  value={draft.city}
                  onChange={(event) =>
                    setDraft({ ...draft, city: event.target.value })
                  }
                  className="app-input font-normal"
                />
              </label>
              <label className="app-label grid gap-1.5">
                Province
                <input
                  maxLength={CLIENT_TEXT_MAX}
                  value={draft.province}
                  onChange={(event) =>
                    setDraft({ ...draft, province: event.target.value })
                  }
                  className="app-input font-normal"
                />
              </label>
            </div>
            <label className="app-label grid gap-1.5">
              Client needs
              <textarea
                rows={3}
                maxLength={CLIENT_NOTES_MAX}
                value={draft.needs_notes}
                onChange={(event) =>
                  setDraft({ ...draft, needs_notes: event.target.value })
                }
                className="app-input min-h-24 py-2 font-normal"
              />
            </label>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeForm}
                className="app-btn app-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="app-btn app-btn-primary"
              >
                {saving
                  ? "Saving…"
                  : editingId
                    ? "Save changes"
                    : "Register lead"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

interface OptionSelectProps {
  id: string;
  label: string;
  kindLabel: string;
  value: string;
  options: MasterOptionRecord[];
  canManageMasterData: boolean;
  onChange: (value: string) => void;
}

/** Pilihan Master Data; daftar kosong menjelaskan siapa yang bisa mengisinya (FR-12.2). */
function OptionSelect({
  id,
  label,
  kindLabel,
  value,
  options,
  canManageMasterData,
  onChange,
}: OptionSelectProps) {
  if (options.length === 0) {
    return (
      <div className="space-y-1">
        <p className="app-label">{label}</p>
        <p className="rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-sm text-on-tertiary-fixed">
          There are no {kindLabel} yet.{" "}
          {canManageMasterData ? (
            <Link
              href="/settings#master-data"
              className="font-semibold underline"
            >
              Add them in Master Data.
            </Link>
          ) : (
            "Ask an Admin to add them in Master Data."
          )}
        </p>
      </div>
    );
  }
  return (
    <label htmlFor={id} className="app-label grid gap-1.5">
      {label}
      <select
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="app-input font-normal"
      >
        <option value="">Choose…</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.is_active ? "" : " (inactive)"}
          </option>
        ))}
      </select>
    </label>
  );
}
