/**
 * Header carrying the request's path from proxy.ts to server code (pages and
 * server actions), set on every request so a client cannot supply its own.
 */
export const REQUEST_PATH_HEADER = "x-fa-path";
