"use client";

import {
  companyLetterhead,
  savePdf,
} from "@/components/finance/invoice-download";
import { buildMouPdf, type MouPdfData } from "@/lib/documents/invoice-pdf";
import type { MouRecord } from "@/lib/gateways/samples";
import { formatRupiah } from "@/lib/validations/sample";
import { REGULATORY_PATH_LABEL } from "./labels";

/** Unduh MoU sebagai PDF satu halaman (v2.5a). Mengembalikan pesan untuk ditampilkan. */
export async function downloadMouPdf(mou: MouRecord) {
  const company = await companyLetterhead();
  return savePdf(`${mou.mou_number}.pdf`, buildMouPdf(mouPdfData(mou, company)));
}

export function mouPdfData(
  mou: MouRecord,
  company: Pick<MouPdfData, "logo"> & { name: string; lines: string[] },
): MouPdfData {
  const client = [mou.client_code, mou.client_name].filter(Boolean).join(" · ");
  return {
    company: { name: company.name, lines: company.lines },
    logo: company.logo,
    mou_number: mou.mou_number,
    issued_on: mou.created_at.slice(0, 10),
    stamp: mou.status === "SENT" ? "" : mou.status,
    client: [
      client,
      mou.client_address ?? "",
      [mou.client_city, mou.client_province].filter(Boolean).join(", "),
    ].filter(Boolean),
    terms: [
      { label: "Product", value: mou.brand_name },
      { label: "Units", value: mou.total_units.toLocaleString("id-ID") },
      {
        label: "Unit price (before tax)",
        value: formatRupiah(mou.unit_price_idr),
      },
      {
        label: "Contract value",
        value: formatRupiah(mou.total_production_cost_idr),
      },
      {
        label: `Down payment (${mou.dp_bp / 100}%)`,
        value: formatRupiah(mou.dp_amount_required_idr),
      },
      {
        label: "Production lead time",
        value: `${mou.production_lead_time_days} days`,
      },
      {
        label: "Regulatory path",
        value: REGULATORY_PATH_LABEL[mou.regulatory_path] ?? mou.regulatory_path,
      },
    ],
    notes: mou.notes,
    footer:
      "Prices exclude taxes. The down payment is invoiced separately; production and product registration start after it is paid.",
    signatures: [`For ${company.name}`, `For ${mou.client_name ?? "the client"}`],
  };
}
