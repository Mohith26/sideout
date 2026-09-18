// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineStatus } from "@/components/offline/OfflineStatus";
import { QueuedScoreNotice } from "@/components/offline/QueuedScoreNotice";
import { ServiceWorkerRegistration } from "@/components/offline/ServiceWorkerRegistration";
import { ToastProvider } from "@/components/ui/Toast";
import { OUTBOX_REPLAYED_EVENT, queueScore, useOutboxStoreForTests } from "@/lib/offline/client";
import { MemoryOutbox, type ReplayReport } from "@/lib/offline/outbox";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const SETS = [
  { setNumber: 1, usPoints: 21, themPoints: 12 },
  { setNumber: 2, usPoints: 21, themPoints: 15 },
];

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

describe("offline surface", () => {
  let store: MemoryOutbox;
  beforeEach(() => {
    store = new MemoryOutbox();
    useOutboxStoreForTests(store);
    refresh.mockReset();
    setOnline(true);
  });
  afterEach(() => {
    cleanup();
    useOutboxStoreForTests(null);
  });

  it("the status line is silent online and plain offline, counting what is queued on this phone", async () => {
    render(
      <ToastProvider>
        <OfflineStatus />
      </ToastProvider>,
    );
    const status = screen.getByTestId("offline-status");
    expect(status).toHaveAttribute("data-offline", "false");
    expect(status).toHaveAttribute("role", "status");
    expect(status.textContent).toBe("");

    await act(async () => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(status).toHaveAttribute("data-offline", "true");
    expect(status).toHaveTextContent("No connection. Pages you have already opened still work. A score you submit now is saved on this phone");

    await act(async () => {
      await queueScore("m1", SETS);
    });
    expect(status).toHaveTextContent("One scoreline is saved on this phone and will be sent when you are back online.");
  });

  it("the match page notice shows the queued scoreline in match orientation, discards it, and refreshes once a replay lands", async () => {
    await queueScore("m1", SETS);
    render(<QueuedScoreNotice matchId="m1" teamA="Ahmadi / El-Amin" teamB="Marchetti / Hayashi" perspective="b" timeZone="America/Los_Angeles" />);
    const notice = await screen.findByTestId("queued-score");
    expect(notice).toHaveAttribute("data-status", "queued");
    expect(notice).toHaveTextContent("Queued on this phone");
    expect(notice).toHaveTextContent("nothing is final until both teams agree");
    // "us" is team B here: the table reads team A first, so the points swap sides.
    const cells = notice.querySelectorAll("td");
    expect([...cells].map((c) => c.textContent)).toContain("12");
    expect([...cells].map((c) => c.textContent)).toContain("21");

    const report: ReplayReport = { outcomes: [{ item: (await store.list())[0]!, result: "sent", message: null }], pending: false };
    act(() => {
      window.dispatchEvent(new CustomEvent(OUTBOX_REPLAYED_EVENT, { detail: report }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard queued scoreline" }));
    });
    expect(screen.queryByTestId("queued-score")).not.toBeInTheDocument();
    expect(await store.list()).toEqual([]);
  });

  it("a refused item reads as refused with the server's reason", async () => {
    const item = await queueScore("m2", SETS);
    await store.put({ ...item, status: "failed", lastError: { code: "illegal_scoreline", message: "Set 2 is not a finished set.", at: 1 } });
    render(<QueuedScoreNotice matchId="m2" teamA="A" teamB="B" perspective="a" timeZone="UTC" />);
    const notice = await screen.findByTestId("queued-score");
    expect(notice).toHaveAttribute("data-status", "failed");
    expect(notice).toHaveTextContent("Your queued scoreline was refused");
    expect(notice).toHaveTextContent("Set 2 is not a finished set.");
  });

  it("registers the worker with the build sha as its version, in production only", () => {
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    render(<ServiceWorkerRegistration version="abc123" enabled={false} />);
    expect(register).not.toHaveBeenCalled();
    render(<ServiceWorkerRegistration version="abc123" enabled />);
    expect(register).toHaveBeenCalledWith("/sw.js?v=abc123", { scope: "/" });
  });
});
