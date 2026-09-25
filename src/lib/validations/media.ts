/**
 * Aturan foto (PRD FR-07) yang WAJIB identik dengan bagian media di
 * `src-tauri/src/desktop/samples.rs` (`validate_media_upload`). Kompresi
 * sendiri dikerjakan webview (`src/lib/media/compress-image.ts`) di ketiga
 * target; Web dan cloud hanya memeriksa ulang hasilnya dengan aturan ini.
 */

/** Jenis foto di tiket sampel. PRD 7.2 punya jenis lain untuk fase berikutnya. */
export const SAMPLE_MEDIA_PURPOSES = ["REFERENCE", "PAYMENT_PROOF"] as const;
export type SampleMediaPurpose = (typeof SAMPLE_MEDIA_PURPOSES)[number];

export const MEDIA_MIME = "image/webp";
/** 300 KB setelah kompresi (FR-07.2). */
export const MEDIA_MAX_BYTES = 307_200;
/** Sisi terpanjang setelah diperkecil (FR-07.1). */
export const MEDIA_MAX_SIDE_PX = 1280;
/** Kualitas WebP 75 (FR-07.1). */
export const MEDIA_WEBP_QUALITY = 0.75;

export const MEDIA_TOO_LARGE =
  "The image is still over 300 KB after compression. Crop the parts you do not need, then upload it again.";
export const MEDIA_NOT_WEBP = "The photo is not a valid WebP image.";
export const MEDIA_PURPOSE_INVALID = "Choose what the photo is for.";

export function isSampleMediaPurpose(
  value: unknown,
): value is SampleMediaPurpose {
  return (
    typeof value === "string" &&
    (SAMPLE_MEDIA_PURPOSES as readonly string[]).includes(value)
  );
}

/** Ukuran tujuan: sisi terpanjang ≤ `max`, rasio dipertahankan, tidak diperbesar. */
export function fitWithin(
  width: number,
  height: number,
  max = MEDIA_MAX_SIDE_PX,
): [number, number] {
  const longest = Math.max(width, height);
  if (longest <= max) return [width, height];
  const scale = max / longest;
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Periksa unggahan: jenis sah, base64 standar yang ketat, WebP sungguhan
 * (`RIFF....WEBP`), dan paling besar `MEDIA_MAX_BYTES`. Mengembalikan ukuran
 * biner. Padanan `validate_media_upload`.
 */
export function validateMediaUpload(
  purpose: unknown,
  dataBase64: unknown,
): { byte_size: number } | { error: string } {
  if (!isSampleMediaPurpose(purpose)) return { error: MEDIA_PURPOSE_INVALID };
  if (
    typeof dataBase64 !== "string" ||
    !dataBase64 ||
    !BASE64.test(dataBase64)
  ) {
    return { error: MEDIA_NOT_WEBP };
  }
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  const size = (dataBase64.length / 4) * 3 - padding;
  if (size > MEDIA_MAX_BYTES) return { error: MEDIA_TOO_LARGE };
  const head = atob(dataBase64.slice(0, 16));
  if (
    size < 12 ||
    head.slice(0, 4) !== "RIFF" ||
    head.slice(8, 12) !== "WEBP"
  ) {
    return { error: MEDIA_NOT_WEBP };
  }
  return { byte_size: size };
}

/** WAJIB identik dengan `samples::MEDIA_INSERT_SQL` (dites per karakter). */
export const MEDIA_INSERT_SQL =
  "INSERT INTO media_asset (id, owner_type, owner_id, purpose, mime, byte_size, data_base64, created_by, created_at) VALUES (?1, 'sample', ?2, ?3, 'image/webp', ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING;";
