import { useEffect, useState } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { cn } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Server route that forwards the chief of staff's board (see apps/server/src/devboxBoard). */
const DEVBOX_BOARD_ROUTE_PATH = "/api/devbox/board";
const REFRESH_MS = 60_000;

interface BoardEntry {
  readonly ref: string;
  readonly title?: string;
  readonly kind?: string;
  readonly who?: string | null;
  readonly due?: string | null;
  readonly note?: string | null;
  readonly area?: string | null;
  /** The chief of staff's one line on why it sits at this rank. */
  readonly why?: string | null;
}

interface BoardData {
  /** What needs Marcus, in the chief of staff's order for this week. */
  readonly ranked: ReadonlyArray<BoardEntry>;
  /** Needs Marcus, not placed in the order yet. */
  readonly unranked: ReadonlyArray<BoardEntry>;
  /** YYYY-MM-DD when fetched, for overdue marks. */
  readonly today: string;
}

async function fetchBoard(signal: AbortSignal): Promise<BoardData | null> {
  const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(DEVBOX_BOARD_ROUTE_PATH), {
    credentials: bearerToken ? "omit" : "include",
    ...(bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : {}),
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Omit<BoardData, "today">;
  return Array.isArray(body.ranked) && Array.isArray(body.unranked)
    ? { ...body, today: new Date().toISOString().slice(0, 10) }
    : null;
}

function useDevboxBoard(): BoardData | null {
  const [board, setBoard] = useState<BoardData | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- polls an external service (the board) while mounted
  useEffect(() => {
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      fetchBoard(controller.signal)
        .then(setBoard)
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  return board;
}

function firstLine(text: string | null | undefined): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

function entryTitle(entry: BoardEntry): string {
  return entry.title ?? (firstLine(entry.note) || entry.area || "");
}

/** Hover text: the whole entry, since rows truncate. Tickets have no title, only the note. */
function EntryDetails({ entry, rank }: { entry: BoardEntry; rank: number | null }) {
  const meta = [
    rank === null ? "not ranked" : `#${rank}`,
    entry.kind ?? entry.area,
    entry.who,
    entry.due ? `due ${entry.due.slice(0, 10)}` : null,
  ].filter(Boolean);
  return (
    <div className="flex max-w-80 flex-col gap-1 py-0.5 text-xs">
      <div className="text-muted-foreground">
        {entry.ref} · {meta.join(" · ")}
      </div>
      <div className="whitespace-pre-wrap">{entry.title ?? (entry.note?.trim() || entry.area)}</div>
      {entry.why ? <div className="text-muted-foreground">Why: {entry.why}</div> : null}
    </div>
  );
}

/** Text a click puts into the composer: the ref the chief of staff knows, plus context. */
function entryCitation(entry: BoardEntry, rank: number | null): string {
  const details = [
    rank === null ? "not ranked" : `#${rank} on the board`,
    entry.kind ?? entry.area,
    entry.who,
    entry.due ? `due ${entry.due.slice(0, 10)}` : null,
  ].filter(Boolean);
  const why = entry.why ? ` (why: ${entry.why})` : "";
  return `${entry.ref} [${details.join(", ")}]: ${entryTitle(entry)}${why}`;
}

/** What needs Marcus, in the chief of staff's order. Hidden when the board service is off. */
export function DevboxBoard() {
  const board = useDevboxBoard();
  const composerRef = useComposerHandleContext();
  if (!board || board.ranked.length + board.unranked.length === 0) return null;

  // A click adds the entry to the composer, like citing; without a composer it is copied.
  const cite = (entry: BoardEntry, rank: number | null) => {
    const text = entryCitation(entry, rank);
    if (composerRef?.current?.insertTextAtEnd(`${text} `, { ensureLeadingBoundary: true })) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => toastManager.add({ type: "info", title: `Copied ${entry.ref}` }))
      .catch(() => toastManager.add({ type: "error", title: `Could not add ${entry.ref}` }));
  };

  const row = (entry: BoardEntry, rank: number | null) => {
    const overdue = entry.due ? entry.due.slice(0, 10) < board.today : false;
    return (
      <Tooltip key={entry.ref}>
        <TooltipTrigger
          delay={300}
          render={
            <button
              type="button"
              onClick={() => cite(entry, rank)}
              aria-label={`Add ${entry.ref} to the composer`}
              className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 cursor-pointer flex-col rounded-sm px-1 py-1 text-left text-xs hover:bg-accent/60"
            />
          }
        >
          <span className="flex min-w-0 items-baseline gap-1.5">
            {rank === null ? null : (
              <span className="w-3.5 shrink-0 text-right text-muted-foreground">{rank}</span>
            )}
            <span className="shrink-0 font-medium text-muted-foreground">{entry.ref}</span>
            <span className="min-w-0 flex-1 truncate">{entryTitle(entry)}</span>
            {entry.due ? (
              <span
                className={cn(
                  "shrink-0 text-2xs",
                  overdue ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {entry.due.slice(5, 10)}
              </span>
            ) : null}
          </span>
          {entry.why ? (
            <span
              className={cn("truncate text-2xs text-muted-foreground", rank !== null && "pl-5")}
            >
              {entry.why}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <EntryDetails entry={entry} rank={rank} />
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-devbox-board-heading"
      title={`Needs you · ${board.ranked.length + board.unranked.length}`}
      // Counted like the lineage list, so a long board scrolls instead of hiding the
      // workspace controls when the card measures its density.
      data-thread-relationships-panel
    >
      <div className="flex max-h-96 flex-col overflow-y-auto px-2.5">
        {board.ranked.map((entry, index) => row(entry, index + 1))}
        {board.unranked.length > 0 ? (
          <>
            <div className="mt-2 mb-0.5 text-2xs text-muted-foreground">
              Not ranked yet · {board.unranked.length}
            </div>
            {board.unranked.map((entry) => row(entry, null))}
          </>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
