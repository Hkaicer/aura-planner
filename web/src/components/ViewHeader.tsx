import { Menu as MenuIcon, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import { useUi } from "../lib/store";
import { IconButton } from "./ui";

export function ViewHeader({ title, sub, actions, leading }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; leading?: ReactNode }) {
  const t = useT();
  const ui = useUi();
  return (
    <header className="view-header">
      <IconButton label="Menu" className="menu-toggle" onClick={() => ui.set({ sidebarOpen: true })}>
        <MenuIcon />
      </IconButton>
      {leading}
      <div className="view-heading">
        <h1 className="view-title">{title}</h1>
        {sub && <span className="view-sub">{sub}</span>}
      </div>
      <div className="view-actions">
        {actions}
        {!ui.assistantOpen && (
          <IconButton label={t("nav.ask")} onClick={() => ui.toggleAssistant(true)} tipPos="left">
            <PanelRight />
          </IconButton>
        )}
      </div>
    </header>
  );
}
