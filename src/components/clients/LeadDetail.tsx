"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import {
  type ClientRecord,
  type LeadInteractionRecord,
  listLeadInteractions,
  listOperatorDirectory,
  type OperatorDirectoryEntry,
  reassignLead,
  recordLeadInteraction,
} from "@/lib/gateways/clients";
import { formatDateTime } from "@/lib/utils/format";
import {
  INTERACTION_NOTES_MAX,
  type LeadInteractionDirection,
  type LeadInteractionKind,
} from "@/lib/validations/client";

/**
 * Panel satu lead: ringkasan, catat interaksi, riwayat, dan pindah PIC
 * (PRD FR-05, OQ-34). Siapa boleh mencatat diputuskan backend; `canRecord`
 * hanya menyembunyikan form yang pasti ditolak.
 */

const KIND_LABEL: Record<LeadInteractionKind, string> = {
  WHATSAPP: "WhatsApp chat",
  CALL: "Phone call",
  VISIT: "Visit",
  MATERIAL: "Sent material",
  OTHER: "Other",
};

const DIRECTION_LABEL: Record<LeadInteractionDirection, string> = {
  OUTBOUND: "Follow up by CS",
  INBOUND: "Client responded",
};

export function describeDays(days: number | null) {
  if (days === null) return "no response recorded";
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

interface LeadDetailProps {
  client: ClientRecord;
  optionLabel: (id: string) => string;
  canRecord: boolean;
  canReassign: boolean;
  canEditClient: boolean;
  onEditClient: () => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

export function LeadDetail({
  client,
  optionLabel,
  canRecord,
  canReassign,
  canEditClient,
  onEditClient,
  onChanged,
  onClose,
}: LeadDetailProps) {
  const leadId = client.lead_id ?? "";
  const [history, setHistory] = useState<LeadInteractionRecord[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] =
    useState<LeadInteractionDirection>("OUTBOUND");
  const [kind, setKind] = useState<LeadInteractionKind>("WHATSAPP");
  const [notes, setNotes] = useState("");
  /** Kosong = sekarang. Nilai `datetime-local` dibaca sebagai jam lokal pengguna. */
  const [when, setWhen] = useState("");
  const [picId, setPicId] = useState(String(client.pic_cs_id ?? ""));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const loadHistory = useCallback(async () => {
    if (!leadId) return;
    try {
      setHistory(await listLeadInteractions(leadId));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "History could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!canReassign) return;
    void listOperatorDirectory()
      .then(setOperators)
      .catch(() => setOperators([]));
  }, [canReassign]);

  const run = async (action: () => Promise<void>, success: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await Promise.all([loadHistory(), onChanged()]);
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const submitInteraction = (event: FormEvent) => {
    event.preventDefault();
    const occurredAt = when
      ? Math.floor(new Date(when).getTime() / 1000)
      : null;
    void run(async () => {
      await recordLeadInteraction({
        lead_id: leadId,
        direction,
        kind,
        notes,
        occurred_at: occurredAt,
      });
      setNotes("");
      setWhen("");
    }, "Interaction recorded.");
  };

  const submitReassign = (event: FormEvent) => {
    event.preventDefault();
    const target = Number(picId);
    if (!target || target === client.pic_cs_id) return;
    void run(() => reassignLead(leadId, target), "Lead reassigned.");
  };

  return (
    <Modal
      title={client.name}
      titleId="lead-detail-title"
      descriptionId="lead-detail-summary"
      onClose={onClose}
    >
      <div className="space-y-4">
        <dl
          id="lead-detail-summary"
          className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm"
        >
          <dt className="text-on-surface-variant">Client code</dt>
          <dd className="font-mono text-on-surface">{client.client_code}</dd>
          <dt className="text-on-surface-variant">WhatsApp</dt>
          <dd className="text-on-surface">+{client.phone_normalized}</dd>
          <dt className="text-on-surface-variant">CS</dt>
          <dd className="text-on-surface">
            {client.pic_cs_name ??
              (client.pic_cs_id ? `#${client.pic_cs_id}` : "-")}
          </dd>
          <dt className="text-on-surface-variant">Category</dt>
          <dd className="text-on-surface">
            {optionLabel(client.product_category_option_id)}
          </dd>
          <dt className="text-on-surface-variant">Last client response</dt>
          <dd className="text-on-surface">
            {describeDays(client.days_since_response)}
          </dd>
          <dt className="text-on-surface-variant">Follow ups</dt>
          <dd className="text-on-surface">
            {client.total_followups}
            {client.last_followup_at
              ? `, last ${formatDateTime(client.last_followup_at)}`
              : ""}
          </dd>
        </dl>
        {client.needs_notes ? (
          <p className="rounded-md bg-surface-container-low p-3 text-body-sm text-on-surface">
            {client.needs_notes}
          </p>
        ) : null}
        {canEditClient ? (
          <button
            type="button"
            onClick={onEditClient}
            className="app-btn app-btn-secondary"
          >
            Edit client details
          </button>
        ) : null}

        {error ? <FeedbackBanner tone="error">{error}</FeedbackBanner> : null}
        {notice ? (
          <FeedbackBanner tone="success">{notice}</FeedbackBanner>
        ) : null}

        {canRecord ? (
          <form
            onSubmit={submitInteraction}
            className="space-y-3 border-t border-surface-container pt-4"
          >
            <h3 className="text-body-md font-semibold text-on-surface">
              Record interaction
            </h3>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="app-label mb-1.5">What happened</legend>
              {(["OUTBOUND", "INBOUND"] as const).map((value) => (
                <label
                  key={value}
                  className={`flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-3 text-center text-body-sm font-semibold ${
                    direction === value
                      ? "border-primary bg-secondary-fixed text-on-secondary-fixed-variant"
                      : "border-outline-variant text-on-surface"
                  }`}
                >
                  <input
                    type="radio"
                    name="lead-direction"
                    value={value}
                    checked={direction === value}
                    onChange={() => setDirection(value)}
                    className="sr-only"
                  />
                  {DIRECTION_LABEL[value]}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="app-label grid gap-1.5">
                Channel
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as LeadInteractionKind)
                  }
                  className="app-input font-normal"
                >
                  {(Object.keys(KIND_LABEL) as LeadInteractionKind[]).map(
                    (value) => (
                      <option key={value} value={value}>
                        {KIND_LABEL[value]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="app-label grid gap-1.5">
                When
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(event) => setWhen(event.target.value)}
                  className="app-input font-normal"
                />
                <span className="font-normal text-body-sm text-on-surface-variant">
                  Leave empty for now.
                </span>
              </label>
            </div>
            <label className="app-label grid gap-1.5">
              Notes
              <textarea
                required
                rows={3}
                maxLength={INTERACTION_NOTES_MAX}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What was said or sent"
                className="app-input min-h-20 py-2 font-normal"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary w-full sm:w-auto"
            >
              {busy ? "Saving…" : "Save interaction"}
            </button>
          </form>
        ) : (
          <p className="border-t border-surface-container pt-4 text-body-sm text-on-surface-variant">
            Only this lead&apos;s CS can record interactions on it.
          </p>
        )}

        {canReassign ? (
          <form
            onSubmit={submitReassign}
            className="flex flex-col gap-2 border-t border-surface-container pt-4 sm:flex-row sm:items-end"
          >
            <label className="app-label grid flex-1 gap-1.5">
              Move to CS
              <select
                value={picId}
                onChange={(event) => setPicId(event.target.value)}
                className="app-input font-normal"
              >
                {operators.length === 0 ? (
                  <option value="">Sync once to load the operator list</option>
                ) : null}
                {operators.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.nama_operator}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={busy || !picId || Number(picId) === client.pic_cs_id}
              className="app-btn app-btn-secondary"
            >
              Reassign
            </button>
          </form>
        ) : null}

        <section className="border-t border-surface-container pt-4">
          <h3 className="text-body-md font-semibold text-on-surface">
            History
          </h3>
          {loading ? (
            <p className="mt-2 text-body-sm text-on-surface-variant">
              Loading…
            </p>
          ) : history.length === 0 ? (
            <p className="mt-2 text-body-sm text-on-surface-variant">
              No interactions yet. The first follow up you record starts the
              count.
            </p>
          ) : (
            <ol className="mt-2 space-y-3">
              {history.map((item) => (
                <li key={item.id} className="text-body-sm">
                  <p className="font-semibold text-on-surface">
                    {DIRECTION_LABEL[
                      item.direction as LeadInteractionDirection
                    ] ?? item.direction}
                    <span className="font-normal text-on-surface-variant">
                      {" "}
                      ·{" "}
                      {KIND_LABEL[item.kind as LeadInteractionKind] ??
                        item.kind}{" "}
                      · {formatDateTime(item.occurred_at)}
                      {item.operator_name ? ` · ${item.operator_name}` : ""}
                    </span>
                  </p>
                  <p className="whitespace-pre-line text-on-surface">
                    {item.notes}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Modal>
  );
}
