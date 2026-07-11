import { z } from "zod";
import { HttpError } from "@/lib/auth/authorize";

/** Parse and validate a JSON request body against a Zod schema, or throw 400. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, `invalid request: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  }
  return parsed.data;
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}
