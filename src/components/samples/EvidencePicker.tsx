"use client";

import { type ChangeEvent, useId, useState } from "react";
import { compressImageToWebp } from "@/lib/media/compress-image";

/**
 * Lampiran satu foto untuk sebuah langkah: tangkapan layar balasan klien
 * (v2.5b, keputusan N), foto dokumen legal (v2.6), atau desain cetak dummy
 * (v2.8). Dikompresi di perangkat seperti foto lain (aturan 38). Input berkas
 * bawaan disembunyikan: tampilannya tidak bisa diberi gaya dan teks "No file
 * chosen"-nya bertentangan dengan lampiran yang sudah ada.
 */
export function EvidencePicker({
  value,
  onChange,
  label = "Screenshot of the client's reply",
  hint = "Required when you record the client's answer yourself.",
}: {
  value: string;
  onChange: (dataBase64: string) => void;
  label?: string;
  hint?: string;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      onChange(await compressImageToWebp(file));
    } catch (cause) {
      onChange("");
      setError(
        cause instanceof Error ? cause.message : "The image was not read.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <span className="app-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-outline-variant bg-surface-container-lowest p-3">
        <input
          id={id}
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(event) => void pick(event)}
          className="sr-only"
        />
        <label
          htmlFor={id}
          aria-disabled={busy}
          className="app-btn app-btn-secondary cursor-pointer"
        >
          {value ? "Replace image" : "Choose image"}
        </label>
        {value && !busy ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="app-btn app-btn-secondary"
          >
            Remove
          </button>
        ) : null}
        <span className="text-body-sm text-on-surface-variant">
          {busy
            ? "Compressing…"
            : value
              ? `Attached (${Math.round((value.length * 3) / 4 / 1024)} KB).`
              : hint}
        </span>
      </div>
      {error ? <p className="text-body-sm text-error">{error}</p> : null}
    </div>
  );
}
