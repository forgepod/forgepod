"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { applySetCookie } from "../apply-set-cookie";

async function complete(
  body: { email: string; password: string; name?: string },
  mode: "sign-up" | "sign-in",
): Promise<void> {
  const instance = await auth();
  let failure: string | null = null;

  try {
    const { headers } =
      mode === "sign-up"
        ? await instance.api.signUpEmail({
            body: body as { email: string; password: string; name: string },
            returnHeaders: true,
          })
        : await instance.api.signInEmail({ body, returnHeaders: true });
    await applySetCookie(headers);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  // redirect() works by throwing, so it stays outside the catch that would swallow it,
  // the same reason the admin actions in app/admin/agents/actions.ts keep it out too.
  redirect(failure ? `/login?error=${encodeURIComponent(failure)}` : "/admin/agents");
}

export async function claimAction(form: FormData): Promise<void> {
  await complete(
    {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      name: String(form.get("name") ?? ""),
    },
    "sign-up",
  );
}

export async function signInAction(form: FormData): Promise<void> {
  await complete(
    { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
    "sign-in",
  );
}
