"use client";

import {
  companyLetterhead,
  savePdf,
} from "@/components/finance/invoice-download";
import { buildTermsPdf } from "@/lib/documents/invoice-pdf";
import type { QcClaimRecord, ShipmentRecord } from "@/lib/gateways/production";
import {
  claimReportNumber,
  QC_REMEDY_LABEL,
  type QcRemedy,
} from "@/lib/validations/production";

/**
 * Surat Jalan dan SOP Penyimpanan (v3.4, PRD F-27, keputusan E/F): dibuat di
 * webview dengan penulis PDF yang sama dengan invoice dan MoU, lalu disimpan
 * lewat gateway dokumen. Mengembalikan pesan untuk ditampilkan.
 */

function deliverTo(shipment: ShipmentRecord | QcClaimRecord) {
  const client = [shipment.client_code, shipment.client_name]
    .filter(Boolean)
    .join(" · ");
  return [client, shipment.ship_to_address].filter(Boolean);
}

/** Ekspedisi + resi, atau sopir + nomor polisi. */
export function shipmentCarrierLine(shipment: ShipmentRecord) {
  if (shipment.method === "FLEET") {
    const phone = shipment.driver_phone ? `, ${shipment.driver_phone}` : "";
    return `Own fleet: ${shipment.driver_name}${phone}, vehicle ${shipment.vehicle_plate}`;
  }
  const tracking = shipment.tracking_no
    ? `, tracking ${shipment.tracking_no}`
    : "";
  return `${shipment.carrier_label || "Courier"}${tracking}`;
}

export async function downloadDeliveryNote(shipment: ShipmentRecord) {
  const company = await companyLetterhead();
  return savePdf(
    `${shipment.delivery_note_no}.pdf`,
    buildTermsPdf("DELIVERY NOTE", {
      company: { name: company.name, lines: company.lines },
      logo: company.logo,
      number: shipment.delivery_note_no,
      issued_on: shipment.ship_on,
      stamp: shipment.status === "CANCELLED" ? "CANCELLED" : "",
      party_label: "Deliver to",
      party: deliverTo(shipment),
      terms_label: "Goods",
      terms: [
        { label: "Product", value: shipment.brand_name },
        { label: "Work order", value: shipment.batch_code },
        { label: "MoU", value: shipment.mou_number },
        { label: "Units", value: shipment.unit_count.toLocaleString("id-ID") },
        {
          label: "Cartons",
          value: shipment.carton_count.toLocaleString("id-ID"),
        },
        { label: "Shipped by", value: shipmentCarrierLine(shipment) },
      ],
      notes_label: "Notes",
      notes: shipment.notes,
      footer:
        "Check the cartons on arrival. Report damaged or missing goods on this delivery note before signing.",
      signatures: [`For ${company.name}`, "Carrier", "Received by"],
    }),
  );
}

/**
 * Berita Acara keputusan QC (v3.5, keputusan D): satu per Surat Jalan,
 * ditandatangani QC, CS, dan klien.
 */
export async function downloadClaimReport(claim: QcClaimRecord) {
  const company = await companyLetterhead();
  const number = claimReportNumber(claim.delivery_note_no);
  const internal = claim.fault_type === "INTERNAL";
  const remedy =
    QC_REMEDY_LABEL[claim.remedy as QcRemedy] ?? (claim.remedy || "-");
  return savePdf(
    `${number}.pdf`,
    buildTermsPdf("QC CLAIM REPORT", {
      company: { name: company.name, lines: company.lines },
      logo: company.logo,
      number,
      issued_on: claim.decided_at.slice(0, 10),
      stamp: "",
      party_label: "Client",
      party: deliverTo(claim),
      terms_label: "Delivery",
      terms: [
        { label: "Product", value: claim.brand_name },
        { label: "Delivery note", value: claim.delivery_note_no },
        { label: "Work order", value: claim.batch_code },
        { label: "Shipped on", value: claim.ship_on },
        {
          label: "Units shipped",
          value: claim.unit_count.toLocaleString("id-ID"),
        },
        {
          label: "Units affected",
          value: claim.affected_units
            ? claim.affected_units.toLocaleString("id-ID")
            : "-",
        },
        {
          label: "Fault",
          value: internal
            ? "Ours (production or packing)"
            : "Recipient or courier",
        },
        {
          label: "Decision",
          value: internal ? `Return approved: ${remedy}` : "Return rejected",
        },
      ],
      notes_label: "Complaint and QC findings",
      notes: [
        `Complaint: ${claim.complaint_notes}`,
        `QC findings: ${claim.findings}`,
        ...(claim.remedy_notes ? [`Follow-up: ${claim.remedy_notes}`] : []),
      ].join("\n"),
      footer: "",
      signatures: ["Quality control", "Customer service", "Client"],
    }),
  );
}

export async function downloadStorageSop(
  shipment: ShipmentRecord,
  sopText: string,
) {
  const company = await companyLetterhead();
  return savePdf(
    `SOP-${shipment.delivery_note_no}.pdf`,
    buildTermsPdf("STORAGE SOP", {
      company: { name: company.name, lines: company.lines },
      logo: company.logo,
      number: shipment.delivery_note_no,
      issued_on: shipment.ship_on,
      stamp: "",
      party_label: "For",
      party: deliverTo(shipment),
      terms_label: "Goods",
      terms: [
        { label: "Product", value: shipment.brand_name },
        { label: "Delivery note", value: shipment.delivery_note_no },
      ],
      notes_label: "How to store these goods",
      notes: sopText,
      footer: "",
      signatures: [],
    }),
  );
}
