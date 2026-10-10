"use client";

import { useRef, useState } from "react";
import { buildXlsx } from "@/lib/documents/xlsx";
import { saveXlsx } from "@/lib/gateways/documents";

/**
 * Daftar kolom yang dikenali impor beserta template Excel-nya (v2.8, PRD
 * D-41): header persis seperti yang dicocokkan otomatis, ditambah satu baris
 * contoh. Backend membatasi template 16 KB.
 */
export function ImportColumnGuide({
  fields,
  templateName,
}: {
  fields: readonly { header: string; rule: string; example: string }[];
  templateName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const isSubmittingRef = useRef(false);

  const download = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      const saved = await saveXlsx(
        templateName,
        buildXlsx([
          fields.map((field) => field.header),
          fields.map((field) => field.example),
        ]),
        "template",
        "template",
        1,
      );
      setMessage(
        saved.path
          ? `Saved to ${saved.path}`
          : saved.savedToDevice
            ? "Template saved."
            : "",
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "The template was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <details className="mt-3 rounded-md border border-surface-container p-3">
      <summary className="cursor-pointer text-body-md font-semibold text-on-surface">
        Columns this import reads
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-body-sm">
          <thead className="text-label-caps text-on-surface-variant">
            <tr>
              <th className="py-2 pr-3">Column</th>
              <th className="py-2 pr-3">Rule</th>
              <th className="py-2">Example</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr
                key={field.header}
                className="border-t border-surface-container align-top"
              >
                <td className="py-2 pr-3 font-semibold">{field.header}</td>
                <td className="py-2 pr-3">{field.rule}</td>
                <td className="py-2 font-mono">{field.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-body-sm text-on-surface-variant">
        Other columns in your file are ignored. Header names do not have to
        match exactly; you can match them by hand after choosing the file.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          className="app-btn app-btn-secondary"
        >
          {busy ? "Saving…" : "Download Excel template"}
        </button>
        {message ? (
          <span className="text-body-sm text-on-surface-variant">
            {message}
          </span>
        ) : null}
      </div>
    </details>
  );
}
