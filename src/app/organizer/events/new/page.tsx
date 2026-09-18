import type { Metadata } from "next";
import Link from "next/link";
import { EventForm } from "@/components/organizer/EventForm";
import { eventFormOptions } from "@/components/organizer/options";
import { Container } from "@/components/shell/Container";
import { Icons } from "@/components/ui/icons";
import { requireOrganizerViewer } from "../../_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New event" };

/** Event builder, create mode (spec §11.6). The event starts as a draft. */
export default async function NewEventPage() {
  await requireOrganizerViewer();
  const options = eventFormOptions();
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <div>
        <Link href="/organizer/events" className="target inline-flex items-center gap-1 rounded-sm type-label text-text-secondary hover:text-text-primary">
          <Icons.chevronLeft size={14} />
          Events
        </Link>
        <h1 className="type-display-l">New event</h1>
      </div>
      <EventForm mode="create" options={options} />
    </Container>
  );
}
