"use client";

import { useRef, useState } from "react";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { buildXlsx, exportFileName, type XlsxCell } from "@/lib/documents/xlsx";
import { type ExportSubject, saveXlsx } from "@/lib/gateways/documents";

/**
 * Ekspor daftar yang sedang tampil (filter dan pencarian ikut) ke Excel
 * .xlsx (v2.8, PRD D-41). Hanya untuk pemegang `data.export`; backend
 * memeriksanya ulang dan mencatat setiap ekspor di log audit. Dibuat dari
 * data yang sudah ada di perangkat, jadi tetap jalan offline.
 */
export function ExportButton({
  subject,
  rows,
}: {
  subject: ExportSubject;
  /** Header lalu baris data; dipanggil hanya saat tombol ditekan. */
  rows: () => XlsxCell[][];
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const isSubmittingRef = useRef(false);

  if (!hasPermission(user, "data.export")) return null;

  const run = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      const table = rows();
      const saved = await saveXlsx(
        exportFileName(subject),
        buildXlsx(table),
        "export",
        subject,
        table.length - 1,
      );
      setMessage(
        saved.path
          ? `Saved to ${saved.path}`
          : saved.savedToDevice
            ? `Exported ${table.length - 1} rows.`
            : "",
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "The list was not exported.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="app-btn app-btn-secondary"
      >
        {busy ? "Exporting…" : "Export Excel"}
      </button>
      {message ? (
        <span className="text-body-sm text-on-surface-variant">{message}</span>
      ) : null}
    </span>
  );
}
