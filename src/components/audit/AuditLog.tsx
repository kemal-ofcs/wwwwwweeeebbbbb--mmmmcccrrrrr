"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  type AuditEntry,
  type AuditFilter,
  listAuditLog,
} from "@/lib/gateways/audit";
import { listOperatorDirectory } from "@/lib/gateways/clients";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Log audit domain (PRD FR-10.3, bagian log dari mockup SCR-07). Hanya-baca:
 * tidak ada aksi di layar ini yang mengubah atau menghapus baris. Ditulis sekali
 * untuk Web-Desktop dan Mobile (`filesToCopy`).
 */

const ENTITY_OPTIONS = [
  ["", "All changes"],
  ["client", "Clients"],
  ["lead", "Leads"],
  ["master_option", "Master data"],
] as const;

const KIND_LABEL: Record<string, string> = {
  LEAD_CHANNEL: "lead channel",
  PRODUCT_CATEGORY: "product category",
};

type Summary = Record<string, unknown>;

function parseSummary(value: string): Summary {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Summary) : {};
  } catch {
    return {};
  }
}

/** Satu kalimat per aksi; aksi yang belum dikenal tetap tampil apa adanya. */
function describe(entry: AuditEntry, operatorName: (id: number) => string) {
  const s = parseSummary(entry.summary_json);
  const code = String(s.client_code ?? entry.entity_id);
  switch (entry.action) {
    case "client.register":
      return `Registered lead ${code} (${String(s.name ?? "")})`;
    case "client.update":
      return `Edited client ${code} (${String(s.name ?? "")})`;
    case "master_option.save":
      return `Saved ${KIND_LABEL[String(s.kind)] ?? "option"} "${String(
        s.label ?? "",
      )}" (${String(s.code ?? "")})${s.is_active === false ? ", turned off" : ""}`;
    case "lead_interaction.record":
      return `Recorded a ${
        s.direction === "INBOUND" ? "client response" : "follow up"
      } on ${code}`;
    case "lead.reassign":
      return `Moved ${code} to ${operatorName(Number(s.pic_cs_id))}`;
    default:
      return `${entry.action} on ${entry.entity_type} ${entry.entity_id}`;
  }
}

const EMPTY_FILTER: AuditFilter = {
  entity_type: "",
  actor_operator_id: 0,
  from: "",
  to: "",
};

export function AuditLog() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_FILTER);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [source, setSource] = useState<"cloud" | "device">("cloud");
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (next: AuditFilter) => {
    setLoading(true);
    try {
      const page = await listAuditLog(next);
      setEntries(page.entries);
      setSource(page.source);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The audit log could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Nama untuk "dipindahkan ke" dan pilihan pelaku. Gagal = tampil sebagai #id.
  useEffect(() => {
    void listOperatorDirectory()
      .then((rows) =>
        setNames(new Map(rows.map((row) => [row.id, row.nama_operator]))),
      )
      .catch(() => setNames(new Map()));
  }, []);

  const operatorName = (id: number) => names.get(id) ?? `operator #${id}`;

  const actors = useMemo(() => {
    const seen = new Map(names);
    for (const entry of entries) {
      if (entry.actor_operator_id != null && entry.actor_name) {
        seen.set(entry.actor_operator_id, entry.actor_name);
      }
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries, names]);

  const filtered =
    filter.entity_type !== "" ||
    filter.actor_operator_id !== 0 ||
    filter.from !== "" ||
    filter.to !== "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Who changed clients, leads, and master data, and when. Entries cannot be edited or deleted."
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}
      {source === "device" ? (
        <FeedbackBanner tone="warning">
          Offline: showing only changes made on this device. Connect to see
          every device and the Web.
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="app-label grid gap-1.5">
          What
          <select
            value={filter.entity_type}
            onChange={(event) =>
              setFilter({ ...filter, entity_type: event.target.value })
            }
            className="app-input font-normal"
          >
            {ENTITY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="app-label grid gap-1.5">
          Who
          <select
            value={filter.actor_operator_id}
            onChange={(event) =>
              setFilter({
                ...filter,
                actor_operator_id: Number(event.target.value),
              })
            }
            className="app-input font-normal"
          >
            <option value={0}>Everyone</option>
            {actors.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="app-label grid gap-1.5">
          From
          <input
            type="date"
            value={filter.from}
            onChange={(event) =>
              setFilter({ ...filter, from: event.target.value })
            }
            className="app-input font-normal"
          />
        </label>
        <label className="app-label grid gap-1.5">
          To
          <input
            type="date"
            value={filter.to}
            onChange={(event) =>
              setFilter({ ...filter, to: event.target.value })
            }
            className="app-input font-normal"
          />
        </label>
      </div>

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            {filtered
              ? "No changes match these filters."
              : "No changes recorded yet. Registering a lead or saving master data adds the first entry."}
          </p>
        ) : (
          <ol className="divide-y divide-surface-container">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <span className="shrink-0 text-body-sm text-on-surface-variant sm:w-40">
                  {formatDateTime(entry.occurred_at)}
                </span>
                <span className="min-w-0 flex-1 text-body-md text-on-surface">
                  {describe(entry, operatorName)}
                </span>
                <span className="shrink-0 text-body-sm text-on-surface-variant sm:text-right">
                  {entry.actor_name ??
                    (entry.actor_operator_id != null
                      ? operatorName(entry.actor_operator_id)
                      : "Unknown")}
                  {entry.on_behalf_of_division
                    ? ` · ${entry.on_behalf_of_division}`
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      {entries.length === 200 ? (
        <p className="text-body-sm text-on-surface-variant">
          Showing the latest 200 entries. Narrow the dates to see older ones.
        </p>
      ) : null}
    </div>
  );
}
