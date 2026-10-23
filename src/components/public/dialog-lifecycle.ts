let modalCount = 0;
let previousOverflow = '';
const openings = new WeakMap<HTMLDialogElement, {opener: HTMLElement | null; url: string}>();

/** Preserve the opening control without stealing focus after navigation or another dialog. */
export function openPublicDialog(dialog: HTMLDialogElement): () => void {
  const opening = (dialog.open && openings.get(dialog)) || {
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    url: location.href,
  };
  openings.set(dialog, opening);
  const {opener, url: openingUrl} = opening;
  if (modalCount++ === 0) previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.showModal();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--modalCount === 0) document.body.style.overflow = previousOverflow;
    // React removes the dialog during the commit. Wait for that and any replacement dialog.
    queueMicrotask(() => {
      if (!opener?.isConnected || location.href !== openingUrl || (dialog.isConnected && dialog.open)) return;
      const active = document.activeElement;
      if (active !== document.body && active !== document.documentElement && active !== null && !dialog.contains(active)) return;
      const openDialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
      if (openDialogs.some(other => !other.contains(opener))) return;
      opener.focus({preventScroll: true});
    });
  };
}
