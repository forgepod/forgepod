import Link from "next/link";
import { Masthead } from "../../../masthead";
import { PageHeader } from "../../../page-header";

export default function AgentNotFound() {
  return (
    <main className="sheet">
      <Masthead here="agents" />
      <PageHeader
        title="No such agent"
        note="It was deleted, or the link is wrong."
      />
      <p className="note">
        <Link href="/admin/agents">Back to agents</Link>
      </p>
    </main>
  );
}
