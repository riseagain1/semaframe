import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ open, title, detail, confirmLabel, tone = "default", onCancel, onConfirm }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-detail" onKeyDown={handleKeyDown}>
      <button type="button" className="icon-close" onClick={onCancel} aria-label="Close"><X size={17} /></button>
      <div className={`dialog-icon tone-${tone}`} aria-hidden="true"><AlertTriangle size={20} /></div>
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-detail">{detail}</p>
      <div className="dialog-actions"><button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button><button type="button" className={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button></div>
    </div>
  </div>;
}
