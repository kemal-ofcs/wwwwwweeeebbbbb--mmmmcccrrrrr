"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import {
  type BusinessSettings,
  getBusinessSettings,
  saveBusinessSettings,
} from "@/lib/gateways/samples";
import {
  DEFAULT_BUSINESS_SETTINGS,
  FREE_REVISION_LIMIT_MAX,
  LEAD_HOT_MAX_DAYS_LIMIT,
  LEAD_WARM_MAX_DAYS_LIMIT,
  type SampleFeeMode,
} from "@/lib/validations/sample";

/**
 * Setelan bisnis per perusahaan (PRD FR-11), diubah pemegang
 * `settings.manage`. Semua nilai ikut sinkronisasi dan berlaku untuk data yang
 * dibuat SESUDAHNYA; kuota klien lama tidak berubah.
 */

const FEE_MODE_LABEL: Record<SampleFeeMode, string> = {
  PER_REQUEST: "Chosen for each request",
  FREE: "Always free",
  PAID: "Always paid",
};

function wholeNumber(value: string) {
  return value === "" ? 0 : Math.trunc(Number(value));
}

export function BusinessSettingsCard({ canManage }: { canManage: boolean }) {
  const [settings, setSettings] = useState<BusinessSettings>(
    DEFAULT_BUSINESS_SETTINGS,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getBusinessSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFeedback({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Business settings could not be loaded.",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      setSettings(await saveBusinessSettings(settings));
      setFeedback({
        tone: "success",
        text: "Saved. New clients and new sample requests use these values.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Business settings could not be saved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="settings" className="size-5" />
        </span>
        <div>
          <h2 className="text-headline-md text-on-surface">
            Business settings
          </h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            How this company handles samples and lead follow up. Changes apply
            to clients and requests created afterwards.
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
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <fieldset disabled={!canManage} className="grid gap-4 sm:grid-cols-2">
            <label className="app-label grid gap-1.5">
              Free sample revisions for a new client
              <input
                required
                type="number"
                min={0}
                max={FREE_REVISION_LIMIT_MAX}
                step={1}
                value={settings.default_free_revision_limit}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    default_free_revision_limit: wholeNumber(
                      event.target.value,
                    ),
                  })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              First sample fee
              <select
                value={settings.sample_fee_mode}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sample_fee_mode: event.target.value as SampleFeeMode,
                  })
                }
                className="app-input font-normal"
              >
                {(Object.keys(FEE_MODE_LABEL) as SampleFeeMode[]).map(
                  (mode) => (
                    <option key={mode} value={mode}>
                      {FEE_MODE_LABEL[mode]}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="app-label grid gap-1.5">
              Hot lead: client responded within (days)
              <input
                required
                type="number"
                min={0}
                max={LEAD_HOT_MAX_DAYS_LIMIT}
                step={1}
                value={settings.lead_hot_max_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    lead_hot_max_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Warm lead: client responded within (days)
              <input
                required
                type="number"
                min={1}
                max={LEAD_WARM_MAX_DAYS_LIMIT}
                step={1}
                value={settings.lead_warm_max_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    lead_warm_max_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                Longer than this is Cold.
              </span>
            </label>
          </fieldset>
          {canManage ? (
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Saving…" : "Save business settings"}
            </button>
          ) : null}
        </form>
      )}
    </section>
  );
}
