"use client";

import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import {
  getMediaDataUrl,
  type SampleMediaEntry,
  uploadSampleMedia,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { compressImageToWebp } from "@/lib/media/compress-image";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Foto tiket sampel (PRD FR-07): referensi produk dan bukti bayar. Foto
 * dikompresi di perangkat sebelum diunggah. Isi foto dimuat satu per satu;
 * di Desktop/Mobile foto yang pernah dimuat tersimpan di perangkat, jadi
 * tetap terlihat saat offline.
 */

const PURPOSE_LABEL: Record<SampleMediaEntry["purpose"], string> = {
  REFERENCE: "Reference",
  PAYMENT_PROOF: "Payment proof",
};

interface SamplePhotosProps {
  sampleId: string;
  media: SampleMediaEntry[];
  canUpload: boolean;
  canUploadPaymentProof: boolean;
  onUploaded: () => void;
}

type Loaded = { url: string } | { error: string };

export function SamplePhotos({
  sampleId,
  media,
  canUpload,
  canUploadPaymentProof,
  onUploaded,
}: SamplePhotosProps) {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [purpose, setPurpose] =
    useState<SampleMediaEntry["purpose"]>("REFERENCE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isSubmittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Muat isi setiap foto yang belum dimuat. Gagal (offline) = placeholder.
  useEffect(() => {
    let cancelled = false;
    for (const entry of media) {
      if (loaded[entry.id]) continue;
      void getMediaDataUrl(entry.id)
        .then((url) => {
          if (!cancelled)
            setLoaded((current) => ({ ...current, [entry.id]: { url } }));
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setLoaded((current) => ({
            ...current,
            [entry.id]: {
              error:
                cause instanceof Error
                  ? cause.message
                  : "This photo is available when the device is online.",
            },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [media, loaded]);

  const pick = (next: SampleMediaEntry["purpose"]) => {
    setPurpose(next);
    setError("");
    setNotice("");
    inputRef.current?.click();
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await compressImageToWebp(file);
      await uploadSampleMedia(sampleId, purpose, data);
      setNotice("Photo added.");
      onUploaded();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The photo was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const current = selected ? loaded[selected] : null;
  const selectedEntry = media.find((entry) => entry.id === selected);

  return (
    <section aria-label="Photos" className="grid gap-3">
      <h3 className="text-body-md font-semibold text-on-surface">Photos</h3>
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}
      {notice ? (
        <FeedbackBanner tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </FeedbackBanner>
      ) : null}

      {media.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant">No photos yet.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {media.map((entry) => {
            const state = loaded[entry.id];
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-label={`${PURPOSE_LABEL[entry.purpose] ?? entry.purpose} photo, ${formatDateTime(entry.created_at)}`}
                  aria-pressed={selected === entry.id}
                  disabled={!state || "error" in state}
                  onClick={() =>
                    setSelected(selected === entry.id ? null : entry.id)
                  }
                  className="grid aspect-square w-full place-items-center overflow-hidden rounded-md border border-surface-container bg-surface-container-low"
                >
                  {state && "url" in state ? (
                    // biome-ignore lint/performance/noImgElement: data URL lokal, bukan aset Next.
                    <img
                      src={state.url}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <span className="p-2 text-center text-body-sm text-on-surface-variant">
                      {state ? "Available when online" : "Loading…"}
                    </span>
                  )}
                </button>
                <p className="mt-1 truncate text-body-sm text-on-surface-variant">
                  {PURPOSE_LABEL[entry.purpose] ?? entry.purpose}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {current && "url" in current ? (
        // biome-ignore lint/performance/noImgElement: data URL lokal, bukan aset Next.
        <img
          src={current.url}
          alt={
            selectedEntry
              ? `${PURPOSE_LABEL[selectedEntry.purpose] ?? selectedEntry.purpose}, added ${formatDateTime(selectedEntry.created_at)}`
              : ""
          }
          className="max-h-[70vh] w-full rounded-md border border-surface-container object-contain"
        />
      ) : null}

      {canUpload ? (
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void upload(event)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => pick("REFERENCE")}
            className="app-btn app-btn-secondary"
          >
            {busy && purpose === "REFERENCE"
              ? "Compressing…"
              : "Add reference photo"}
          </button>
          {canUploadPaymentProof ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => pick("PAYMENT_PROOF")}
              className="app-btn app-btn-secondary"
            >
              {busy && purpose === "PAYMENT_PROOF"
                ? "Compressing…"
                : "Add payment proof"}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="text-body-sm text-on-surface-variant">
        Photos are shrunk to 1280 px and saved as WebP on this device. Anything
        still over 300 KB is refused.
      </p>
    </section>
  );
}
