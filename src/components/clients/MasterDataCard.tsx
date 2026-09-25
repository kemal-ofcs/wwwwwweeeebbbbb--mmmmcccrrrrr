"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  listMasterOptions,
  type MasterOptionDraft,
  type MasterOptionRecord,
  saveMasterOption,
} from "@/lib/gateways/clients";
import {
  MASTER_OPTION_KINDS,
  type MasterOptionKind,
  OPTION_LABEL_MAX,
} from "@/lib/validations/client";

/**
 * Master Data (PRD FR-12): daftar pilihan milik perusahaan sendiri. Database
 * baru mulai kosong. Pilihan tidak pernah dihapus, hanya dinonaktifkan, supaya
 * klien lama yang memakainya tetap terbaca.
 */

const KIND_TITLE: Record<MasterOptionKind, string> = {
  LEAD_CHANNEL: "Lead channels",
  PRODUCT_CATEGORY: "Product categories",
};

const KIND_HINT: Record<MasterOptionKind, string> = {
  LEAD_CHANNEL: "Where a lead came from, e.g. ADS · Ads, IG · Instagram.",
  PRODUCT_CATEGORY: "What the client wants to make, e.g. SKIN · Skincare.",
};

function emptyDraft(kind: MasterOptionKind): MasterOptionDraft {
  return { id: "", kind, code: "", label: "", is_active: true };
}

export function MasterDataCard() {
  const [options, setOptions] = useState<MasterOptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<MasterOptionDraft | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setOptions(await listMasterOptions());
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Master data could not be loaded.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (next: MasterOptionDraft, successText: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await saveMasterOption(next);
      setDraft(null);
      setFeedback({ tone: "success", text: successText });
      await refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The option could not be saved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft) void save(draft, "Option saved.");
  };

  const toggle = (option: MasterOptionRecord) =>
    void save(
      {
        id: option.id,
        kind: option.kind as MasterOptionKind,
        code: option.code,
        label: option.label,
        is_active: !option.is_active,
      },
      option.is_active
        ? `${option.label} is now hidden from new forms.`
        : `${option.label} is available again.`,
    );

  return (
    <section id="master-data" className="app-panel scroll-mt-20 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="database" className="size-5" />
        </span>
        <div>
          <h2 className="text-headline-md text-on-surface">Master data</h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            The choices shown in the lead form. Options that are already used
            cannot be deleted; turn them off instead and they disappear from new
            forms while existing clients keep them.
          </p>
        </div>
      </div>

      {feedback ? (
        <div className="mt-4">
          <FeedbackBanner
            tone={feedback.tone}
            onDismiss={() => setFeedback(null)}
          >
            {feedback.text}
          </FeedbackBanner>
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 text-body-md text-on-surface-variant">Loading…</p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {MASTER_OPTION_KINDS.map((kind) => {
            const rows = options.filter((option) => option.kind === kind);
            const editing = draft?.kind === kind ? draft : null;
            return (
              <div
                key={kind}
                className="space-y-3 rounded-md border border-surface-container bg-surface-container-low p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-body-md font-semibold text-on-surface">
                      {KIND_TITLE[kind]}
                    </h3>
                    <p className="text-body-sm text-on-surface-variant">
                      {KIND_HINT[kind]}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraft(emptyDraft(kind))}
                    className="app-btn app-btn-secondary shrink-0"
                  >
                    <Icon name="plus" className="size-4" />
                    Add
                  </button>
                </div>

                {rows.length === 0 ? (
                  <p className="text-body-sm text-on-surface-variant">
                    Nothing yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-surface-container rounded-md border border-surface-container bg-surface-container-lowest">
                    {rows.map((option) => (
                      <li
                        key={option.id}
                        className="flex flex-wrap items-center gap-2 px-3 py-2"
                      >
                        <span className="font-mono text-body-sm text-on-surface-variant">
                          {option.code}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body-md text-on-surface">
                          {option.label}
                        </span>
                        {option.is_active ? null : (
                          <StatusBadge tone="neutral">Off</StatusBadge>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              id: option.id,
                              kind,
                              code: option.code,
                              label: option.label,
                              is_active: option.is_active,
                            })
                          }
                          aria-label={`Edit ${option.label}`}
                          className="app-btn app-btn-secondary"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => toggle(option)}
                          className="app-btn app-btn-secondary"
                        >
                          {option.is_active ? "Turn off" : "Turn on"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {editing ? (
                  <form
                    onSubmit={submit}
                    className="grid gap-3 rounded-md border border-surface-container bg-surface-container-lowest p-3 sm:grid-cols-[8rem_1fr]"
                  >
                    <label className="app-label grid gap-1.5">
                      Code
                      <input
                        required
                        maxLength={20}
                        pattern="[A-Za-z0-9_\-]{1,20}"
                        value={editing.code}
                        onChange={(event) =>
                          setDraft({ ...editing, code: event.target.value })
                        }
                        className="app-input font-mono font-normal uppercase"
                      />
                    </label>
                    <label className="app-label grid gap-1.5">
                      Name
                      <input
                        required
                        maxLength={OPTION_LABEL_MAX}
                        value={editing.label}
                        onChange={(event) =>
                          setDraft({ ...editing, label: event.target.value })
                        }
                        className="app-input font-normal"
                      />
                    </label>
                    <div className="flex gap-2 sm:col-span-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="app-btn app-btn-primary"
                      >
                        {busy ? "Saving…" : editing.id ? "Save" : "Add option"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraft(null)}
                        className="app-btn app-btn-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
