"use client";

import { type ChangeEvent, useId, useState } from "react";
import { compressImageToWebp } from "@/lib/media/compress-image";

/**
 * Tangkapan layar balasan klien untuk jawaban yang dicatat manual (v2.5b,
 * keputusan N). Dikompresi di perangkat seperti foto lain (aturan 38);
 * backend menolak langkah jawaban klien tanpa foto ini.
 */
export function EvidencePicker({
  value,
  onChange,
  label = "Screenshot of the client's reply",
  hint = "Required when you record the client's answer yourself.",
}: {
  value: string;
  onChange: (dataBase64: string) => void;
  /** Dipakai juga untuk foto dokumen legal (v2.6). */
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
        cause instanceof Error ? cause.message : "The screenshot was not read.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="app-label">
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={(event) => void pick(event)}
        className="text-body-sm text-on-surface"
      />
      <p className="text-body-sm text-on-surface-variant">
        {busy
          ? "Compressing…"
          : value
            ? `Attached (${Math.round((value.length * 3) / 4 / 1024)} KB).`
            : hint}
      </p>
      {error ? <p className="text-body-sm text-error">{error}</p> : null}
    </div>
  );
}
