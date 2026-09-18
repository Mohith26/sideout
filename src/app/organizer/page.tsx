import { redirect } from "next/navigation";
import { requireOrganizerViewer } from "./_lib";

export const dynamic = "force-dynamic";

/** The console opens on the event list. */
export default async function OrganizerIndex() {
  await requireOrganizerViewer();
  redirect("/organizer/events");
}
