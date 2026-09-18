import { Container } from "@/components/shell/Container";
import { FormSkeleton, PageHeadingSkeleton } from "@/components/ui/Skeleton";

/** Sign-in: a title, one sentence, the phone field and its button. */
export default function SignInLoading() {
  return (
    <Container className="py-6 md:py-8">
      <div className="mx-auto max-w-md space-y-6">
        <PageHeadingSkeleton />
        <FormSkeleton fields={1} />
      </div>
    </Container>
  );
}
