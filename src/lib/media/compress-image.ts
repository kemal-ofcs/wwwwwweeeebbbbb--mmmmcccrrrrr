"use client";

import {
  fitWithin,
  MEDIA_MAX_BYTES,
  MEDIA_MIME,
  MEDIA_TOO_LARGE,
  MEDIA_WEBP_QUALITY,
} from "@/lib/validations/media";

/**
 * Kompresi foto di perangkat (PRD FR-07.1): sisi terpanjang ≤ 1280 px, WebP
 * kualitas 75, tanpa satu pun request jaringan. Dipakai Web, Desktop, dan
 * Mobile; hasilnya diperiksa ulang backend (`validateMediaUpload`).
 */

export const WEBP_UNSUPPORTED =
  "This device cannot save photos as WebP. Use Chrome, Edge, or the Windows or Android app.";
export const IMAGE_UNREADABLE = "This file could not be read as an image.";

async function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob(resolve, MEDIA_MIME, MEDIA_WEBP_QUALITY),
  );
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Mengembalikan base64 WebP, atau melempar Error berpesan untuk pengguna. */
export async function compressImageToWebp(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    // `imageOrientation` menegakkan foto HP yang disimpan miring (EXIF).
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(IMAGE_UNREADABLE);
  }
  const [width, height] = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error(IMAGE_UNREADABLE);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await toBlob(canvas);
  canvas.width = 0;
  canvas.height = 0;
  // Peramban yang tidak bisa meng-encode WebP diam-diam mengembalikan PNG.
  if (!blob || blob.type !== MEDIA_MIME) throw new Error(WEBP_UNSUPPORTED);
  if (blob.size > MEDIA_MAX_BYTES) throw new Error(MEDIA_TOO_LARGE);
  return toBase64(await blob.arrayBuffer());
}
