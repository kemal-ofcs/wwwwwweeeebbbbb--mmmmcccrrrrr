"use client";

import {
  buildInvoicePdf,
  type InvoicePdfData,
  type PdfLogo,
} from "@/lib/documents/invoice-pdf";
import { getCompanyProfile } from "@/lib/gateways/company-profile";
import { saveDocument } from "@/lib/gateways/documents";
import { getFinanceOverview, type InvoiceRecord } from "@/lib/gateways/finance";
import { INVOICE_TYPE_LABEL } from "./labels";

/**
 * Unduh satu tagihan sebagai PDF (v2.3c). Kop dari Company profile, instruksi
 * pembayaran dari setelan bisnis; keduanya dibaca saat tombol ditekan supaya
 * selalu nilai terbaru. Mengembalikan pesan untuk ditampilkan.
 */
export async function downloadInvoicePdf(invoice: InvoiceRecord) {
  const [company, overview] = await Promise.all([
    companyLetterhead(),
    getFinanceOverview(),
  ]);
  const data = invoicePdfData(invoice, {
    ...company,
    payment_instructions: overview.defaults.invoice_payment_instructions,
  });
  return savePdf(`${invoice.invoice_number}.pdf`, buildInvoicePdf(data));
}

/** Kop dokumen dari Company profile, dibaca saat tombol ditekan (MoU memakainya juga). */
export async function companyLetterhead() {
  const profile = await getCompanyProfile();
  return {
    name: profile.company_name,
    lines: [
      profile.address ?? "",
      [profile.phone, profile.email, profile.website]
        .filter(Boolean)
        .join(" · "),
    ].filter(Boolean),
    logo: profile.logo_url ? await logoToJpeg(profile.logo_url) : null,
  };
}

/** Simpan PDF dan kembalikan pesan untuk ditampilkan. */
export async function savePdf(fileName: string, bytes: Uint8Array) {
  const saved = await saveDocument(fileName, bytes);
  if (!saved.savedToDevice) return "Saving was cancelled.";
  return saved.path ? `Saved to ${saved.path}` : "PDF saved.";
}

interface Letterhead {
  name: string;
  lines: string[];
  logo: PdfLogo | null;
  payment_instructions: string;
}

export function invoicePdfData(
  invoice: InvoiceRecord,
  letterhead: Letterhead,
): InvoicePdfData {
  const type = INVOICE_TYPE_LABEL[invoice.ref_type] ?? invoice.ref_type;
  const taxes = JSON.parse(invoice.taxes_json || "[]") as {
    label: string;
    rate_bp: number;
    amount_idr: number;
  }[];
  const percent = (bp: number) => `${bp / 100}%`;
  return {
    company: { name: letterhead.name, lines: letterhead.lines },
    logo: letterhead.logo,
    invoice_number: invoice.invoice_number,
    issued_on: invoice.issued_on,
    due_on: invoice.due_on,
    stamp:
      invoice.status === "CANCELLED"
        ? "CANCELLED"
        : invoice.status === "RESCHEDULED"
          ? "IN INSTALLMENTS"
          : invoice.paid_idr >= invoice.total_idr
            ? "PAID"
            : "",
    stamp_note: invoice.status === "CANCELLED" ? invoice.cancel_reason : "",
    bill_to: [
      [invoice.client_code, invoice.client_name].filter(Boolean).join(" · "),
      invoice.client_address ?? "",
      [invoice.client_city, invoice.client_province].filter(Boolean).join(", "),
    ].filter(Boolean),
    items: [
      {
        label:
          invoice.description.trim() ||
          [type, invoice.brand_name].filter(Boolean).join(" - "),
        amount_idr: invoice.subtotal_idr,
      },
    ],
    summary: [
      { label: "Subtotal", amount_idr: invoice.subtotal_idr },
      ...(invoice.discount_idr > 0
        ? [
            {
              label: `${invoice.discount_label} (${percent(invoice.discount_bp)})`,
              amount_idr: -invoice.discount_idr,
            },
          ]
        : []),
      ...taxes.map((tax) => ({
        label: `${tax.label} (${percent(tax.rate_bp)})`,
        amount_idr: tax.amount_idr,
      })),
    ],
    total_idr: invoice.total_idr,
    paid_idr: invoice.paid_idr,
    payment_instructions: letterhead.payment_instructions,
  };
}

/**
 * Logo (data URI apa pun yang bisa dibaca browser) → JPEG di atas latar putih,
 * sisi terpanjang ≤ 480 px. Gagal dibaca = invoice tanpa logo, bukan galat.
 */
async function logoToJpeg(source: string): Promise<PdfLogo | null> {
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(
      1,
      480 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "";
    const jpeg = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return { jpeg, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}
