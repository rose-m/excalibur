type ShortcutEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented">;

export function isCommentShortcut(event: ShortcutEvent) {
  return event.key.toLowerCase() === "c" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !event.repeat && !event.isComposing && !event.defaultPrevented;
}

// Kept separate from DOM globals so focus/typing exclusions can be tested in Node.
export function commentShortcutTarget(target: { closest: (selector: string) => unknown }) {
  return !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]');
}
