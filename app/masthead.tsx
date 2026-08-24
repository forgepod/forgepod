import Link from "next/link";

export function Masthead({ here }: { here: "plugins" | "agents" | "templates" }) {
  return (
    <header className="masthead">
      <span className="wordmark">ForgePod</span>
      <nav className="crumb">
        <Link href="/admin/agents" aria-current={here === "agents" ? "page" : undefined}>
          agents
        </Link>
        <Link href="/admin/plugins" aria-current={here === "plugins" ? "page" : undefined}>
          plugins
        </Link>
        <Link href="/admin/templates" aria-current={here === "templates" ? "page" : undefined}>
          templates
        </Link>
      </nav>
    </header>
  );
}
