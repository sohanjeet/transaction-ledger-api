import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, "Route not found", "NOT_FOUND"));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map(({ path, message, code }) => ({ path, message, code })),
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  // express.json() rejects malformed, oversized or badly encoded bodies with http-errors style 4xx errors.
  const bodyError = error as { status?: unknown; expose?: unknown; type?: unknown; message?: unknown };
  if (typeof bodyError.status === "number" && bodyError.status >= 400 && bodyError.status < 500 && bodyError.expose === true) {
    const malformed = bodyError.type === "entity.parse.failed";
    res.status(bodyError.status).json({
      error: {
        code: malformed ? "INVALID_JSON" : bodyError.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST_BODY",
        message: malformed ? "Request body is not valid JSON" : String(bodyError.message),
      },
    });
    return;
  }

  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};
