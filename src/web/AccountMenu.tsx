import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Organization } from "./organizations.js";
import { organizationUrl } from "./organizations.js";

export function AccountMenu({ email, organizations, organizationId, onSignOut }: {
  email: string;
  organizations: readonly Organization[];
  organizationId: string | undefined;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last" | "selected">("selected");
  const current = organizations.find(org => org.id === organizationId);

  useEffect(() => {
    if (!open) return;
    const items = panel.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]');
    const selected = panel.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    const target = initialFocus.current === "last" ? items?.[items.length - 1]
      : initialFocus.current === "selected" ? selected ?? items?.[0] : items?.[0];
    target?.focus();
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    if (open && event.key === "Tab") {
      setOpen(false);
      trigger.current?.focus();
    }
    if (open && event.key === " " && event.target instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.target.click();
    }
    if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className="account-menu" ref={container} onKeyDown={onKeyDown}>
    <button className="account-trigger" ref={trigger} aria-label="Account" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initialFocus.current = "selected"; setOpen(value => !value); }}
      onKeyDown={event => {
        if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }
      }}>
      <span className="account-avatar" aria-hidden="true">{email.charAt(0).toUpperCase() || "A"}</span>
      <span>Account</span>
      <svg className="account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div className="account-menu-content" id={id} ref={panel} role="menu" aria-label="Account">
      <div className="account-identity" role="presentation">
        <span className="account-caption">Signed in as</span>
        <span className="account-email">{email}</span>
      </div>
      {organizations.length > 0 && <div className="account-organizations" role="group" aria-label="Organizations">
        <p className="account-caption" aria-hidden="true">Organizations</p>
        <div className="account-org-list">
          {organizations.map(org => <a key={org.id} className="account-org" href={organizationUrl(org.id)} role="menuitemradio" aria-checked={org.id === current?.id}
            onClick={event => {
              // Real navigation leaves credentials untouched if the editor's
              // unsaved-change prompt is cancelled. Do not reload the active org.
              if (org.id === current?.id) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
            }}>
            <span className="organization-icon" aria-hidden="true">{org.name.charAt(0).toUpperCase()}</span>
            <span className="organization-name">{org.name}</span>
            {org.id === current?.id && <svg className="organization-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
          </a>)}
        </div>
      </div>}
      <div className="account-menu-footer" role="presentation">
        <button className="account-signout" role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); onSignOut(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 5H5v14h4m5-14 7 7-7 7m-5-7h12" /></svg>
          Sign out
        </button>
      </div>
    </div>}
  </div>;
}
