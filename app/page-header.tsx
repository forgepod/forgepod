import type { ReactNode } from "react";

/**
 * One header shape for every page: the name on the left, whatever acts on the page on
 * the right, and a single line underneath saying what is true right now.
 */
export function PageHeader({
  title,
  action,
  status,
  note,
}: {
  title: string;
  action?: ReactNode;
  status?: string;
  note?: string;
}) {
  return (
    <>
      <div className="summary">
        <h1>{title}</h1>
        {action}
      </div>
      {status ? <p className="tally">{status}</p> : null}
      {note ? <p className="note">{note}</p> : null}
    </>
  );
}
