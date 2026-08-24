"use client";

/** Deletion asks once. Everything else on this page is undoable by saving again. */
export function ConfirmButton({ children, question }: { children: string; question: string }) {
  return (
    <button
      type="submit"
      className="action action-danger"
      onClick={(event) => {
        if (!confirm(question)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
