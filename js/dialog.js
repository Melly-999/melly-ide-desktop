// One active Workspace modal; background state is restored exactly on close.
export class WorkspaceDialog {
  constructor() { this.active = null; }

  open(overlay, dialog, initialFocus = dialog) {
    if (this.active?.overlay === overlay) { initialFocus?.focus(); return; }
    this.close();
    const origin = document.activeElement;
    const background = [];
    for (let node = overlay; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node) { background.push([sibling, sibling.inert]); sibling.inert = true; }
      }
    }
    overlay.style.display = 'flex';
    const focusables = () => [...dialog.querySelectorAll('button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]')]
      .filter(el => el.getClientRects().length && !el.closest('[inert]'));
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      if (event.key === 'Tab') {
        const items = focusables();
        const first = items[0] || dialog;
        const last = items.at(-1) || dialog;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const focusin = event => { if (!dialog.contains(event.target)) (focusables()[0] || dialog).focus(); };
    this.active = { overlay, origin, background, keydown, focusin };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    initialFocus?.focus();
  }

  close() {
    if (!this.active) return;
    const { overlay, origin, background, keydown, focusin } = this.active;
    this.active = null;
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('focusin', focusin);
    overlay.style.display = 'none';
    for (const [element, inert] of background) element.inert = inert;
    if (origin?.isConnected) origin.focus();
  }
}
