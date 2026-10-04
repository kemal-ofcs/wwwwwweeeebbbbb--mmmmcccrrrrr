/**
 * Tautan dari lonceng notifikasi ke satu klien atau tiket (PRD FR-08).
 *
 * Halaman membaca `?id=`/`?tab=` saat pertama dibuka. Bila lonceng diklik
 * ketika halamannya sudah terbuka, komponen tidak dipasang ulang, jadi lonceng
 * memancarkan event ini dan workspace membuka detailnya sendiri.
 */
export const OPEN_DETAIL_EVENT = "maklonos:open-detail";

export interface OpenDetail {
  id?: string;
  tab?: string;
}

export function requestedDetail(): OpenDetail {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return {
    id: params.get("id") ?? undefined,
    tab: params.get("tab") ?? undefined,
  };
}

export function onOpenDetail(handler: (detail: OpenDetail) => void) {
  const listener = (event: Event) =>
    handler((event as CustomEvent<OpenDetail>).detail ?? {});
  window.addEventListener(OPEN_DETAIL_EVENT, listener);
  return () => window.removeEventListener(OPEN_DETAIL_EVENT, listener);
}
