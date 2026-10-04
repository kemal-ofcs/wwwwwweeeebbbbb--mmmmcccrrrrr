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
  getTelegramSettings,
  retryFailedNotifications,
  saveTelegramConfig,
  sendTestTelegram,
  type TelegramSettings,
  type TelegramTestResult,
} from "@/lib/gateways/notifications";
import { formatDateTime } from "@/lib/utils/format";
import {
  NOTIFICATION_DIVISIONS,
  type NotificationDivision,
} from "@/lib/validations/notification";

/**
 * Pengaturan › Notifikasi (PRD FR-08). Token bot cloud-only dan tidak pernah
 * dikembalikan; chat ID grup per divisi ada di kartu Setelan Bisnis. Kiriman
 * yang gagal 5 kali tampil di sini dengan error Telegram apa adanya (E-09).
 */

const EVENT_LABEL: Record<string, string> = {
  LEAD_NEW: "New lead",
  COLD_DIGEST: "Cold leads summary",
  SAMPLE_RND_REVIEW: "Waiting for RnD review",
  SAMPLE_WAITING_PAYMENT: "Sample fee awaited",
  SAMPLE_PENDING_FEE: "Revision fee decision",
};

const DIVISION_LABEL: Record<NotificationDivision, string> = {
  CS: "CS",
  RND: "RnD",
  FINANCE: "Finance",
};

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function TelegramSettingsCard() {
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [botToken, setBotToken] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [busy, setBusy] = useState<
    "save" | "retry" | NotificationDivision | null
  >(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [test, setTest] = useState<
    (TelegramTestResult & { division: NotificationDivision }) | null
  >(null);
  const isSubmittingRef = useRef(false);

  const apply = useCallback((value: TelegramSettings) => {
    setSettings(value);
    setIsActive(value.config.is_active);
    setBotToken("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getTelegramSettings()
      .then((value) => {
        if (!cancelled) apply(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFeedback({
            tone: "error",
            text: message(
              error,
              "Telegram settings could not be loaded. They need a connection to the database.",
            ),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const run = async (
    kind: "save" | "retry" | NotificationDivision,
    action: () => Promise<void>,
  ) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(kind);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: message(error, "Something went wrong."),
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("save", async () => {
      apply(
        await saveTelegramConfig({ bot_token: botToken, is_active: isActive }),
      );
      setFeedback({ tone: "success", text: "Telegram settings saved." });
    });
  };

  const sendTest = (division: NotificationDivision) =>
    run(division, async () => {
      setTest(null);
      setTest({ ...(await sendTestTelegram(division)), division });
    });

  const retry = () =>
    run("retry", async () => {
      apply(await retryFailedNotifications());
      setFeedback({
        tone: "success",
        text: "Failed notifications are queued again and are being sent.",
      });
    });

  const active = settings?.config.is_active === true;

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
            <Icon name="bell" className="size-5" />
          </span>
          <div>
            <h2 className="text-headline-md text-on-surface">
              Telegram notifications
            </h2>
            <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
              New leads, Cold leads, and sample requests waiting for RnD or
              Finance are sent to each division's Telegram group. Add the bot to
              every group, then set the group chat IDs in Business settings.
            </p>
          </div>
        </div>
        <StatusBadge tone={active ? "success" : "warning"}>
          {active ? "On" : "Off"}
        </StatusBadge>
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

      <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <label className="app-label grid gap-1.5 sm:col-span-2">
          Bot token
          <input
            type="password"
            autoComplete="off"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder={
              settings?.config.has_bot_token
                ? "Saved. Fill in only to replace it"
                : "Paste the token from @BotFather"
            }
            className="app-input font-mono font-normal"
          />
          <span className="text-body-sm font-normal text-on-surface-variant">
            The token is never shown again after it is saved.
          </span>
        </label>

        <label className="flex min-h-11 items-center gap-3 text-body-md font-semibold text-on-surface sm:col-span-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="size-4 accent-secondary"
          />
          Send notifications to Telegram
        </label>

        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="app-btn app-btn-primary"
          >
            {busy === "save" ? "Saving..." : "Save Telegram settings"}
          </button>
          {NOTIFICATION_DIVISIONS.map((division) => (
            <button
              key={division}
              type="button"
              onClick={() => void sendTest(division)}
              disabled={busy !== null || !settings?.config.has_bot_token}
              className="app-btn app-btn-secondary"
            >
              {busy === division
                ? "Sending..."
                : `Test ${DIVISION_LABEL[division]} group`}
            </button>
          ))}
        </div>
      </form>

      {test ? (
        <div
          role={test.delivered ? "status" : "alert"}
          className={`mt-3 rounded-md border p-3 text-body-md ${
            test.delivered
              ? "border-success/30 bg-success-container text-on-success-container"
              : "border-error/30 bg-error-container text-on-error-container"
          }`}
        >
          <p className="font-semibold">
            {test.delivered
              ? `Test message sent to the ${DIVISION_LABEL[test.division]} group.`
              : `Telegram did not accept the test message for the ${DIVISION_LABEL[test.division]} group.`}
          </p>
          {test.detail ? (
            <p className="mt-1 wrap-break-word font-mono text-code-sm opacity-80">
              {test.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {settings ? (
        <div className="mt-5 border-t border-surface-container pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body-md text-on-surface-variant">
              Waiting to send: {settings.pending}. Failed after 5 tries:{" "}
              {settings.failed.length}.
            </p>
            {settings.failed.length > 0 ? (
              <button
                type="button"
                onClick={() => void retry()}
                disabled={busy !== null}
                className="app-btn app-btn-secondary"
              >
                <Icon name="refresh" className="size-4" />
                {busy === "retry" ? "Retrying..." : "Retry failed"}
              </button>
            ) : null}
          </div>
          {settings.failed.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-body-sm">
                <thead className="text-label-caps text-on-surface-variant">
                  <tr>
                    <th className="py-2 pr-3">Event</th>
                    <th className="py-2 pr-3">Group</th>
                    <th className="py-2 pr-3">Happened</th>
                    <th className="py-2">Telegram error</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.failed.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-surface-container align-top"
                    >
                      <td className="py-2 pr-3">
                        {EVENT_LABEL[row.event_type] ?? row.event_type}
                      </td>
                      <td className="py-2 pr-3">
                        {DIVISION_LABEL[
                          row.target_division as NotificationDivision
                        ] ?? row.target_division}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatDateTime(row.occurred_at)}
                      </td>
                      <td className="py-2 font-mono text-code-sm wrap-break-word">
                        {row.last_error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {settings.config.updated_at ? (
            <p className="mt-2 text-body-sm text-on-surface-variant">
              Last saved {formatDateTime(settings.config.updated_at)} by{" "}
              {settings.config.updated_by || "system"}.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
