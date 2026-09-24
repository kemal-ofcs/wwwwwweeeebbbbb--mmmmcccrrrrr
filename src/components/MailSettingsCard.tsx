"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  getMailConfig,
  type MailTestResult,
  saveMailConfig,
  sendTestMail,
} from "@/lib/gateways/mail-config";
import {
  describeMailFailure,
  isMailProvider,
  MAIL_PROVIDER_LABEL,
  MAIL_PROVIDER_REQUIREMENT,
  MAIL_PROVIDERS,
  type MailConfig,
} from "@/lib/mail/mail-config";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Konfigurasi pengirim email sistem.
 *
 * Satu-satunya konsumennya saat ini adalah link "Lupa Password". Tanpa
 * konfigurasi ini fitur tersebut mati total — tidak ada jalur lain untuk
 * menyampaikan token reset — jadi kartu ini menyatakannya terang-terangan
 * alih-alih membiarkan operator menemukannya saat sedang terkunci.
 */
export function MailSettingsCard() {
  const [config, setConfig] = useState<MailConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<MailConfig["provider"]>("resend");
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [resetBaseUrl, setResetBaseUrl] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MailTestResult | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const applyConfig = useCallback((value: MailConfig) => {
    setConfig(value);
    setProvider(value.provider);
    setSenderEmail(value.senderEmail);
    setSenderName(value.senderName);
    setResetBaseUrl(value.resetBaseUrl);
    setIsActive(value.isActive);
    setApiKey("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getMailConfig()
      .then((value) => {
        if (!cancelled) applyConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConfig]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      applyConfig(
        await saveMailConfig({
          provider,
          apiKey,
          senderEmail,
          senderName,
          resetBaseUrl,
          isActive,
        }),
      );
      setFeedback({
        tone: "success",
        text: "System email settings saved.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The email settings could not be saved.",
      });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await sendTestMail());
    } catch (error) {
      setTestResult({
        delivered: false,
        message:
          error instanceof Error
            ? error.message
            : "The test email could not be run.",
        detail: "",
        to: "",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
            <Icon name="tools" className="size-5" />
          </span>
          <div>
            <h2 className="text-headline-md text-on-surface">
              System email (forgot password)
            </h2>
            <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
              Password recovery links are sent through the email provider's HTTP
              API. While this is off, operators who forget their password cannot
              recover their account by email.
            </p>
          </div>
        </div>
        <StatusBadge tone={config?.isActive ? "success" : "warning"}>
          {config?.isActive ? "On" : "Off"}
        </StatusBadge>
      </div>

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-4 rounded-md border p-3 text-body-md ${
            feedback.tone === "success"
              ? "border-success/30 bg-success-container text-on-success-container"
              : "border-error/30 bg-error-container text-on-error-container"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <label className="app-label grid gap-1.5">
          Provider
          <select
            value={provider}
            onChange={(event) => {
              if (isMailProvider(event.target.value)) {
                setProvider(event.target.value);
              }
            }}
            className="app-input font-normal"
          >
            {MAIL_PROVIDERS.map((item) => (
              <option key={item} value={item}>
                {MAIL_PROVIDER_LABEL[item]}
              </option>
            ))}
          </select>
          <span className="text-body-sm font-normal text-on-surface-variant">
            {MAIL_PROVIDER_REQUIREMENT[provider]}
          </span>
        </label>

        <label className="app-label grid gap-1.5">
          API key
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              config?.hasApiKey
                ? "Saved. Fill in only to replace it"
                : "Paste the provider API key"
            }
            className="app-input font-normal"
          />
          <span className="text-body-sm font-normal text-on-surface-variant">
            The key is never shown again after it is saved.
          </span>
        </label>

        <label className="app-label grid gap-1.5">
          Sender email
          <input
            type="email"
            value={senderEmail}
            onChange={(event) => setSenderEmail(event.target.value)}
            placeholder="no-reply@company.co.id"
            className="app-input font-normal"
          />
        </label>

        <label className="app-label grid gap-1.5">
          Sender name
          <input
            value={senderName}
            onChange={(event) => setSenderName(event.target.value)}
            placeholder="App Template"
            className="app-input font-normal"
          />
        </label>

        <label className="app-label grid gap-1.5 sm:col-span-2">
          Reset page URL (optional)
          <input
            value={resetBaseUrl}
            onChange={(event) => setResetBaseUrl(event.target.value)}
            placeholder="https://app.company.co.id"
            className="app-input font-normal"
          />
          <span className="text-body-sm font-normal text-on-surface-variant">
            Fill in when the Web app is deployed. If empty, the email only
            contains the reset code and the operator enters it in the Desktop or
            Mobile app.
          </span>
        </label>

        <label className="flex min-h-11 items-center gap-3 text-body-md font-semibold text-on-surface sm:col-span-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="size-4 accent-secondary"
          />
          Send system emails
        </label>

        <div className="sm:col-span-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Saving..." : "Save email settings"}
            </button>
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing || !config?.hasApiKey}
              className="app-btn app-btn-secondary"
            >
              {testing ? "Sending..." : "Send test email"}
            </button>
          </div>
          {testResult ? (
            <div
              role={testResult.delivered ? "status" : "alert"}
              className={`mt-3 rounded-md border p-3 text-body-md ${
                testResult.delivered
                  ? "border-success/30 bg-success-container text-on-success-container"
                  : "border-error/30 bg-error-container text-on-error-container"
              }`}
            >
              <p className="font-semibold">{testResult.message}</p>
              {describeMailFailure(testResult.detail) ? (
                <p className="mt-1">{describeMailFailure(testResult.detail)}</p>
              ) : null}
              {testResult.detail ? (
                // Penjelasan apa adanya dari penyedia. Inilah yang menjawab
                // "kenapa HTTP 403" — biasanya domain pengirim belum diverifikasi.
                <p className="mt-1 wrap-break-word font-mono text-code-sm opacity-80">
                  {testResult.detail}
                </p>
              ) : null}
            </div>
          ) : null}
          {config?.updatedAt ? (
            <p className="mt-2 text-body-sm text-on-surface-variant">
              Last saved {formatDateTime(config.updatedAt)} by{" "}
              {config.updatedBy || "system"}.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
