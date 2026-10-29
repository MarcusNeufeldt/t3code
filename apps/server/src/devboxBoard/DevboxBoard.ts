import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpServerResponse } from "effect/http";

/**
 * Devbox task board: the thread details card shows the chief of staff's board. The data comes
 * from a local read-only board service (chief-of-staff `scripts/board.py`); this route only
 * forwards its JSON so the browser stays on T3's origin and auth. Unset or unreachable service:
 * 503, and the card hides the section.
 */

export const DEVBOX_BOARD_ROUTE_PATH = "/api/devbox/board";
const DEFAULT_BOARD_URL = "http://127.0.0.1:3781/api/board";
const BOARD_TIMEOUT = "5 seconds";

const boardResponse = (body: string) =>
  HttpServerResponse.text(body, {
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );

export const handleDevboxBoardRequest = Effect.fn("DevboxBoard.handleRequest")(function* () {
  const boardUrl = process.env.T3_DEVBOX_BOARD_URL?.trim() || DEFAULT_BOARD_URL;
  if (boardUrl === "off") return errorResponse(404, "board disabled");
  const httpClient = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const response = yield* httpClient.execute(HttpClientRequest.get(boardUrl));
    const body = yield* response.text;
    return response.status >= 200 && response.status < 300
      ? boardResponse(body)
      : errorResponse(503, "board service error");
  }).pipe(
    Effect.timeout(BOARD_TIMEOUT),
    Effect.orElseSucceed(() => errorResponse(503, "board service unreachable")),
  );
});
