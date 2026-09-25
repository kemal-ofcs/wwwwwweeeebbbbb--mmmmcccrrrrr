import { describe, expect, test } from "bun:test";
import {
  fitWithin,
  MEDIA_MAX_BYTES,
  MEDIA_NOT_WEBP,
  MEDIA_PURPOSE_INVALID,
  MEDIA_TOO_LARGE,
  validateMediaUpload,
} from "./media";

// Vektor kembar dengan `media_upload_divalidasi` di `samples.rs`.

const TINY_WEBP = "UklGRgwAAABXRUJQVlA4TA=="; // "RIFF....WEBPVP8L"
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function webpOfSize(bytes: number) {
  const raw = new Uint8Array(bytes);
  raw.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
  return Buffer.from(raw).toString("base64");
}

describe("validateMediaUpload", () => {
  const cases: [unknown, unknown, { byte_size: number } | { error: string }][] =
    [
      ["REFERENCE", TINY_WEBP, { byte_size: 16 }],
      ["PAYMENT_PROOF", TINY_WEBP, { byte_size: 16 }],
      ["MOCKUP", TINY_WEBP, { error: MEDIA_PURPOSE_INVALID }],
      ["REFERENCE", PNG, { error: MEDIA_NOT_WEBP }],
      ["REFERENCE", "not base64!", { error: MEDIA_NOT_WEBP }],
      ["REFERENCE", "UklGRgwAAABXRUJQVlA4TA", { error: MEDIA_NOT_WEBP }],
      ["REFERENCE", "", { error: MEDIA_NOT_WEBP }],
      ["REFERENCE", "UklGRg==", { error: MEDIA_NOT_WEBP }],
    ];
  for (const [purpose, data, expected] of cases) {
    test(`${String(purpose)} ${String(data).slice(0, 12)}`, () => {
      expect(validateMediaUpload(purpose, data)).toEqual(expected);
    });
  }
  test("batas 300 KB tepat", () => {
    expect(
      validateMediaUpload("REFERENCE", webpOfSize(MEDIA_MAX_BYTES)),
    ).toEqual({
      byte_size: MEDIA_MAX_BYTES,
    });
    expect(
      validateMediaUpload("REFERENCE", webpOfSize(MEDIA_MAX_BYTES + 1)),
    ).toEqual({ error: MEDIA_TOO_LARGE });
  });
});

test("fitWithin: 4000×3000 menjadi 1280×960, yang kecil tidak diperbesar", () => {
  expect(fitWithin(4000, 3000)).toEqual([1280, 960]);
  expect(fitWithin(3000, 4000)).toEqual([960, 1280]);
  expect(fitWithin(800, 600)).toEqual([800, 600]);
  expect(fitWithin(5000, 2)).toEqual([1280, 1]);
});
