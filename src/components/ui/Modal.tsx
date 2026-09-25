import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "./Icon";

interface ModalProps {
  children: ReactNode;
  descriptionId?: string;
  /**
   * `false` = tidak ada tombol tutup dan Escape diabaikan; pengguna WAJIB
   * memilih salah satu aksi di dalamnya (mis. sesi yang tersusul).
   */
  dismissible?: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
}

function focusDialog(node: HTMLDivElement | null) {
  node?.focus();
}

/**
 * Dipakai Web, Desktop, dan Mobile (disalin lewat `filesToCopy`). Pemanggil
 * yang memutuskan kapan dirender; komponen ini tidak menyimpan state buka/tutup.
 */
export function Modal({
  children,
  descriptionId,
  dismissible = true,
  onClose,
  title,
  titleId,
}: ModalProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && dismissible) onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-inverse-surface/40 p-3 backdrop-blur-sm sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        ref={focusDialog}
        onKeyDown={handleKeyDown}
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-surface-container bg-surface-container-lowest p-4 shadow-[0_8px_32px_rgb(11_28_48/0.16)] sm:p-5"
      >
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-surface-container pb-3">
          <h2 id={titleId} className="text-headline-md text-on-surface">
            {title}
          </h2>
          {dismissible ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="grid size-11 shrink-0 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container-low"
            >
              <Icon name="x" className="size-4" />
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
