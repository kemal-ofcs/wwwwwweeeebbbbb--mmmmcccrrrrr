"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import {
  type ClientCodeSettings,
  getClientCodeSettings,
  saveClientCodeSettings,
} from "@/lib/gateways/clients";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import {
  DEFAULT_CLIENT_CODE_PREFIX,
  DEFAULT_CLIENT_CODE_WEB_TAG,
} from "@/lib/validations/client";

/**
 * Pengaturan kode klien `<AWALAN>-YYYYMMDD-<TAG><NN>` (PRD D-06, keputusan B1).
 * Awalan dan tag Web ikut sinkronisasi; tag perangkat diterbitkan database dan
 * hanya ditampilkan. Kode yang sudah terbit tidak pernah berubah.
 */
export function ClientCodeCard() {
  const [settings, setSettings] = useState<ClientCodeSettings>({
    client_code_prefix: DEFAULT_CLIENT_CODE_PREFIX,
    client_code_web_tag: DEFAULT_CLIENT_CODE_WEB_TAG,
    device_tag: null,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getClientCodeSettings()
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
              : "Client code settings could not be loaded.",
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
      setSettings(
        await saveClientCodeSettings({
          client_code_prefix: settings.client_code_prefix,
          client_code_web_tag: settings.client_code_web_tag,
        }),
      );
      setFeedback({
        tone: "success",
        text: "Saved. Codes already issued keep their old form.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Client code settings could not be saved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const example = `${settings.client_code_prefix || DEFAULT_CLIENT_CODE_PREFIX}-20260925-${
    settings.device_tag ?? settings.client_code_web_tag ?? "WB"
  }01`;

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="users" className="size-5" />
        </span>
        <div>
          <h2 className="text-headline-md text-on-surface">Client codes</h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            New clients get a code like{" "}
            <span className="font-mono">{example}</span>: prefix, company date,
            the device code, and a running number.
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
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="app-label grid gap-1.5">
              Prefix
              <input
                required
                minLength={2}
                maxLength={5}
                pattern="[A-Za-z]{2,5}"
                value={settings.client_code_prefix}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    client_code_prefix: event.target.value,
                  })
                }
                className="app-input font-mono font-normal uppercase"
              />
              <span className="font-normal text-body-sm text-on-surface-variant">
                2-5 letters.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              Web code
              <input
                required
                minLength={2}
                maxLength={2}
                pattern="[A-Za-z0-9]{2}"
                value={settings.client_code_web_tag}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    client_code_web_tag: event.target.value,
                  })
                }
                className="app-input font-mono font-normal uppercase"
              />
              <span className="font-normal text-body-sm text-on-surface-variant">
                Used for clients registered in the browser. It cannot match a
                device code.
              </span>
            </label>
          </div>
          {isDesktopRuntime() ? (
            <p className="text-body-sm text-on-surface-variant">
              This device&apos;s code:{" "}
              <span className="font-mono font-semibold text-on-surface">
                {settings.device_tag ?? "not issued yet (sync once)"}
              </span>
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-primary w-full sm:w-auto"
          >
            {busy ? "Saving…" : "Save client codes"}
          </button>
        </form>
      )}
    </section>
  );
}
