import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Better Auth's handler takes a plain Request and returns a plain Response, so the shell
// is three lines and nothing under src/ has to know Next exists.
const handler = async (request: Request) => (await auth()).handler(request);

export { handler as GET, handler as POST };
