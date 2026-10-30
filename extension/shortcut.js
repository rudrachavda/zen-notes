// Firefox's shortcut settings can't use "/", so ⌘/ is caught on each page instead.
// It doesn't fire on about: pages or while the address bar has focus.
if (!window.__zenNotesShortcut) {
  window.__zenNotesShortcut = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "/" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      browser.runtime.sendMessage({ type: "new" });
    },
    true
  );
}
