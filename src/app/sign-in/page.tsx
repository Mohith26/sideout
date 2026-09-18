import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { loadAsync } from "@/lib/load";
import { safeNextPath } from "@/lib/redirects";
import { viewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

/**
 * Phone sign-in (spec §11.4 needs a phone identity for invites). A signed-in
 * visitor is sent straight back to where they were going; `next` is only ever
 * honoured as a same-origin path.
 */
export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const target = safeNextPath(next, "/me");
  const loaded = await loadAsync(() => viewer());
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  if (loaded.data) redirect(target);
  return (
    <Container className="py-6 md:py-8">
      <div className="mx-auto max-w-md">
        <h1 className="type-display-l">Sign in</h1>
        <p className="mt-2 text-text-secondary">Enter your phone number and we will text you a six-digit code. No password, no email.</p>
        <SignInForm next={target} className="mt-6" />
      </div>
    </Container>
  );
}
