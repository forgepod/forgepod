"use client";

import { useActionState } from "react";
import { issueKeyAction, type IssueKeyState } from "./actions";

const initialState: IssueKeyState = { key: null, error: null };

/**
 * A client component, not a plain `<form action={issueKeyAction}>`, because the
 * plaintext key has to land somewhere other than the URL. `useActionState` runs the
 * server action and hands its return value back as component state instead of a
 * redirect, so the key stays in this tab's React state and nowhere else: not the
 * address bar, not history, not a log line.
 */
export function IssueKeyForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(issueKeyAction, initialState);

  return (
    <div className="row">
      <form action={formAction} className="row">
        <input type="hidden" name="userId" value={userId} />
        <input name="name" placeholder="Key name (optional)" className="field" />
        <button type="submit" className="action-quiet" disabled={pending}>
          Issue key
        </button>
      </form>

      {state.error ? (
        <div className="failure">
          <p>{state.error}</p>
        </div>
      ) : null}

      {state.key ? (
        <div className="failure asking">
          <p>
            New key: <code className="mono">{state.key}</code>
          </p>
          <p>
            Shown once, kept only in this tab. Copy it now: reloading this page loses it
            for good.
          </p>
        </div>
      ) : null}
    </div>
  );
}
