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
  APPROVAL_TTL_DAYS_LIMIT,
  DEFAULT_BUSINESS_SETTINGS,
  FREE_REVISION_LIMIT_MAX,
  INVOICE_DUE_DAYS_LIMIT,
  LEAD_HOT_MAX_DAYS_LIMIT,
  LEAD_WARM_MAX_DAYS_LIMIT,
  MAX_DUMMY_REJECTIONS_LIMIT,
  MAX_PHOTOS_PER_SAMPLE_LIMIT,
  OFFLINE_LOGIN_MAX_DAYS_LIMIT,
  PAYMENT_INSTRUCTIONS_MAX,
  type SampleFeeMode,
  STORAGE_GRACE_DAYS_LIMIT,
  STORAGE_SOP_MAX,
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
            <label className="app-label grid gap-1.5">
              Photos of each kind per sample request
              <input
                required
                type="number"
                min={1}
                max={MAX_PHOTOS_PER_SAMPLE_LIMIT}
                step={1}
                value={settings.max_photos_per_sample}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    max_photos_per_sample: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Dummy rejections before an override is needed
              <input
                required
                type="number"
                min={0}
                max={MAX_DUMMY_REJECTIONS_LIMIT}
                step={1}
                value={settings.max_dummy_rejections}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    max_dummy_rejections: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                0 means no limit.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              Free storage after packing (days)
              <input
                required
                type="number"
                min={0}
                max={STORAGE_GRACE_DAYS_LIMIT}
                step={1}
                value={settings.storage_grace_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    storage_grace_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                Goods waiting for the settlement payment are stored free for
                this many calendar days.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              Storage fee per carton per day (IDR)
              <input
                required
                type="number"
                min={0}
                step={1}
                value={settings.storage_fee_idr}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    storage_fee_idr: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                0 means no storage fee.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              MoU down payment (%)
              <input
                required
                type="number"
                min={0.01}
                max={100}
                step={0.01}
                value={settings.dp_percentage_bp / 100}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    dp_percentage_bp: Math.round(
                      Number(event.target.value) * 100,
                    ),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                Copied into each new MoU. Finance can change it per MoU.
              </span>
            </label>
            <label className="app-label grid gap-1.5 sm:col-span-2">
              Approval web address
              <input
                type="url"
                inputMode="url"
                value={settings.approval_web_url}
                placeholder="https://crm.your-company.id"
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    approval_web_url: event.target.value,
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                The Web app clients open to approve samples, dummies, and MoUs.
                Leave it empty to use WhatsApp messages only.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              Approval links last (days)
              <input
                required
                type="number"
                min={1}
                max={APPROVAL_TTL_DAYS_LIMIT}
                step={1}
                value={settings.approval_token_ttl_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    approval_token_ttl_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Offline sign-in period (days)
              <input
                required
                type="number"
                min={1}
                max={OFFLINE_LOGIN_MAX_DAYS_LIMIT}
                step={1}
                value={settings.offline_login_max_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    offline_login_max_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                How long the Desktop and Mobile apps can sign in without a
                connection, counted from the last online sign-in. At most{" "}
                {OFFLINE_LOGIN_MAX_DAYS_LIMIT} days.
              </span>
            </label>
          </fieldset>
          <fieldset disabled={!canManage} className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-body-md text-on-surface-variant">
              Invoices. Default fees only prefill the invoice form; 0 leaves it
              empty.
            </legend>
            {(
              [
                ["default_sample_fee_idr", "Default sample fee (Rp)"],
                ["default_test_fee_idr", "Default testing fee (Rp)"],
                ["default_dummy_fee_idr", "Default dummy fee (Rp)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="app-label grid gap-1.5">
                {label}
                <input
                  required
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={settings[key]}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      [key]: wholeNumber(event.target.value),
                    })
                  }
                  className="app-input font-normal"
                />
              </label>
            ))}
            <label className="app-label grid gap-1.5">
              Invoice due after (days)
              <input
                required
                type="number"
                min={0}
                max={INVOICE_DUE_DAYS_LIMIT}
                step={1}
                value={settings.invoice_due_days}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    invoice_due_days: wholeNumber(event.target.value),
                  })
                }
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5 sm:col-span-2">
              Payment instructions on the invoice PDF
              <textarea
                rows={3}
                maxLength={PAYMENT_INSTRUCTIONS_MAX}
                value={settings.invoice_payment_instructions}
                placeholder="Transfer to BCA 1234567890 a.n. Company Name"
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    invoice_payment_instructions: event.target.value,
                  })
                }
                className="app-input min-h-24 py-2 font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5 sm:col-span-2">
              Storage SOP printed with each shipment
              <textarea
                rows={4}
                maxLength={STORAGE_SOP_MAX}
                value={settings.storage_sop_text}
                placeholder="Store below 25°C, away from direct sunlight. Stack at most 5 cartons."
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    storage_sop_text: event.target.value,
                  })
                }
                className="app-input min-h-24 py-2 font-normal"
              />
              <span className="text-body-sm font-normal text-on-surface-variant">
                Leave empty to skip the storage SOP document.
              </span>
            </label>
          </fieldset>
          <fieldset disabled={!canManage} className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-body-md text-on-surface-variant">
              Telegram group chat ID per division. Leave empty to keep that
              division's events in the app only.
            </legend>
            {(
              [
                ["telegram_chat_id_cs", "CS group"],
                ["telegram_chat_id_rnd", "RnD group"],
                ["telegram_chat_id_finance", "Finance group"],
                ["telegram_chat_id_design", "Design group"],
                ["telegram_chat_id_production", "Production group"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="app-label grid gap-1.5">
                {label}
                <input
                  value={settings[key]}
                  placeholder="-1001234567890"
                  onChange={(event) =>
                    setSettings({ ...settings, [key]: event.target.value })
                  }
                  className="app-input font-mono font-normal"
                />
              </label>
            ))}
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
