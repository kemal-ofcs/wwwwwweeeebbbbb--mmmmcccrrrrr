"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type ApprovalView,
  readApproval,
  respondApproval,
} from "@/lib/gateways/approval";
import { formatDateTime } from "@/lib/utils/format";
import type { ApprovalDecision } from "@/lib/validations/approval";
import { APPROVAL_INVALID } from "@/lib/validations/approval";

/**
 * Halaman persetujuan klien (v2.5b, PRD F-18, US-08/US-19). Terbuka tanpa
 * login: tokennya sekali pakai, kedaluwarsanya dihitung database, dan Web
 * menerapkan jawabannya dengan aturan langkah yang sama seperti staf.
 * Hanya ada di Web (Desktop dan Android tidak melayani klien).
 */

const KIND_TITLE: Record<string, string> = {
  SAMPLE: "Sample approval",
  DUMMY: "Packaging dummy approval",
  MOU: "MoU approval",
};

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  APPROVE: "Approve",
  REVISE: "Request changes",
  REJECT: "Reject",
};

/** Nomor perusahaan untuk tombol WhatsApp E-24; `0812…` menjadi `62812…`. */
function whatsappLink(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  return `https://wa.me/${digits.startsWith("0") ? `62${digits.slice(1)}` : digits}`;
}

export default function ApprovePage() {
  const [token, setToken] = useState("");
  const [view, setView] = useState<ApprovalView | null>(null);
  const [decision, setDecision] = useState<ApprovalDecision | "">("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("t") ?? "";
    setToken(value);
    readApproval(value)
      .then(setView)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "The page could not load.",
        ),
      );
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await respondApproval(token, {
        decision,
        responder_name: name,
        notes,
      });
      setDone(DECISION_LABEL[decision]);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Your answer was not sent.";
      if (message === APPROVAL_INVALID && view) {
        setView({ valid: false, company: view.company });
      }
      setError(message);
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const company = view?.company;
  const contact = company ? whatsappLink(company.phone) : "";

  return (
    <main className="mx-auto grid min-h-screen max-w-xl content-start gap-4 px-4 py-10">
      <header className="grid gap-1">
        <p className="text-body-sm text-on-surface-variant">
          {company?.name || "Approval"}
        </p>
        <h1 className="text-headline-md text-on-surface">
          {view?.valid
            ? (KIND_TITLE[view.entity_type] ?? "Approval")
            : "Approval"}
        </h1>
      </header>

      {!view && !error ? (
        <p className="text-body-md text-on-surface-variant">Loading…</p>
      ) : null}

      {done ? (
        <section className="grid gap-2 rounded-md border border-surface-container p-4">
          <p className="text-body-md font-semibold text-on-surface">
            Thank you. Your answer ({done.toLowerCase()}) was sent.
          </p>
          <p className="text-body-sm text-on-surface-variant">
            You can close this page.
          </p>
        </section>
      ) : view && !view.valid ? (
        <section className="grid gap-3 rounded-md border border-surface-container p-4">
          <p className="text-body-md text-on-surface">{APPROVAL_INVALID}</p>
          <p className="text-body-sm text-on-surface-variant">
            It may have been answered already, replaced by a newer link, or
            expired. Ask us for a new one.
          </p>
          {contact ? (
            <a
              href={contact}
              target="_blank"
              rel="noopener noreferrer"
              className="app-btn app-btn-primary justify-self-start"
            >
              Message us on WhatsApp
            </a>
          ) : null}
        </section>
      ) : view?.valid ? (
        <form onSubmit={submit} className="grid gap-4">
          <section className="grid gap-2 rounded-md border border-surface-container p-4">
            <p className="text-body-md font-semibold text-on-surface">
              {view.brand_name} for {view.client_name}
            </p>
            <dl className="grid gap-1">
              {view.details.map((detail) => (
                <div
                  key={detail.label}
                  className="flex flex-wrap justify-between gap-2 text-body-sm"
                >
                  <dt className="text-on-surface-variant">{detail.label}</dt>
                  <dd className="text-right font-semibold text-on-surface">
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-body-sm text-on-surface-variant">
              This link can be used once, until{" "}
              {formatDateTime(view.expires_at)}.
            </p>
          </section>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-body-md font-semibold text-on-surface">
              Your answer
            </legend>
            {view.decisions.map((option) => (
              <label
                key={option}
                className="flex min-h-11 items-center gap-2 text-body-md text-on-surface"
              >
                <input
                  type="radio"
                  name="decision"
                  value={option}
                  checked={decision === option}
                  onChange={() => setDecision(option)}
                />
                {DECISION_LABEL[option]}
              </label>
            ))}
          </fieldset>

          <label className="app-label grid gap-1.5">
            Your name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            {decision === "REVISE"
              ? "What should we change?"
              : "Notes (optional)"}
            <textarea
              required={decision === "REVISE"}
              rows={4}
              maxLength={800}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="app-input min-h-24 py-2 font-normal"
            />
          </label>

          {error ? (
            <p role="alert" className="text-body-sm text-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !decision}
            className="app-btn app-btn-primary justify-self-start"
          >
            {busy ? "Sending…" : "Send my answer"}
          </button>
        </form>
      ) : error ? (
        <p role="alert" className="text-body-md text-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
