/** `EmptyState({title, body, action?})` (06 UI-50, UI-34: always say why and offer a next action). */
import type { ReactNode } from 'react';

/** Message for a list or page with nothing to show, with an optional action. */
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h2 className="empty-title">{title}</h2>
      <div className="empty-body">{body}</div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
