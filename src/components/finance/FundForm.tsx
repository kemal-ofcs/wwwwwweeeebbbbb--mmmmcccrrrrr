"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import type { ClientRecord } from "@/lib/gateways/clients";
import { recordIncomingFund } from "@/lib/gateways/finance";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { compressImageToWebp } from "@/lib/media/compress-image";
import { FUND_DESCRIPTION_MAX } from "@/lib/validations/finance";
import { localToday } from "./labels";

/**
 * Catat uang masuk dari mutasi bank (PRD F-17, keputusan F). Klien dan foto
 * bukti opsional; foto dikompresi di perangkat seperti foto tiket (FR-07).
 */

interface FundFormProps {
  clients: ClientRecord[];
  onSaved: () => void;
  onClose: () => void;
}

export function FundForm({ clients, onSaved, onClose }: FundFormProps) {
  const [receivedOn, setReceivedOn] = useState(localToday);
  const [amount, setAmount] = useState("");
  const [clientId, setClientId] = useState("");
  const [description, setDescription] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await recordIncomingFund({
        received_on: receivedOn,
        amount_idr: amount.trim() === "" ? 0 : Number(amount),
        client_id: clientId,
        description,
        proof_base64: proof ? await compressImageToWebp(proof) : "",
      });
      requestSyncNow();
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The incoming payment was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record incoming payment"
      titleId="fund-form-title"
      onClose={onClose}
    >
      <form onSubmit={save} className="grid gap-4">
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        <p className="text-body-sm text-on-surface-variant">
          Copy it from the bank statement. Allocate it to an invoice afterwards.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="app-label grid gap-1.5">
            Date received
            <input
              required
              type="date"
              value={receivedOn}
              onChange={(event) => setReceivedOn(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Amount (Rp)
            <input
              required
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Client (optional)
            <select
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className="app-input font-normal"
            >
              <option value="">Not known yet</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.client_code} · {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            Description (optional)
            <input
              maxLength={FUND_DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="For example the bank and sender name"
              className="app-input font-normal"
            />
          </label>
        </div>
        <label className="app-label grid gap-1.5">
          Transfer proof photo (optional)
          <input
            type="file"
            accept="image/*"
            onChange={(event) => setProof(event.target.files?.[0] ?? null)}
            className="app-input py-2 font-normal"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-primary"
          >
            {busy ? "Saving…" : "Record payment"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="app-btn app-btn-secondary"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
