import { z } from "zod";
import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { currentRequest, log } from "@/lib/log";
import { VariableError } from "@/lib/sql/variables";
import { TimeRangeError } from "@/lib/time";
import { QueryExecutionError } from "@/lib/timescaledb/client";

/**
 * What an MCP tool is, on the server side (#148).
 *
 * A tool is a thin, typed façade over a domain function the HTTP routes
 * already call: it carries no authority of its own. Its `run` receives the
 * caller's verified identity and applies exactly the `assertAuthorized`
 * check the matching route applies, and it records the same audit event.
 * The input schema is the one contract: it validates what the client sent
 * and, as JSON Schema, is what `tools/list` advertises, so the two cannot
 * drift. Where the IR accepts more than it advertises (a stored spec of an
 * earlier version), `parse` validates and `input` documents.
 *
 * A tool's failure — an argument the schema refuses, a refusal by `can()`,
 * a statement the guard rejects, a rate limit — is reported in the result
 * with `isError`, as the protocol wants, so the model can read it and try
 * again. An unexpected error is logged with the request id and answered
 * with an opaque message, as `errorResponse` does for the routes.
 */

export interface McpToolContext {
  identity: Identity;
}

/** The protocol's tool annotations: hints, never authority. */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> {
  name: string;
  title: string;
  description: string;
  /** Validates the arguments and, as JSON Schema, documents them. */
  input: I;
  /** Validates instead of `input` when the accepted form is wider than the documented one. */
  parse?: z.ZodType<z.output<I>>;
  /**
   * Declared only when every result matches it exactly: a client may validate
   * `structuredContent` against it and refuse the call otherwise.
   */
  output?: O;
  annotations: McpToolAnnotations;
  run(args: z.output<I>, ctx: McpToolContext): Promise<z.output<O>>;
}

export const READ_ONLY: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Infers the argument and result types from the schemas. */
export function defineTool<I extends z.ZodObject, O extends z.ZodType>(
  tool: McpTool<I, O>,
): McpTool {
  return tool as unknown as McpTool;
}

/** A zod schema as the JSON Schema a client is shown. */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  });
  return rest;
}

/** One entry of a `tools/list` result. */
export function toolDescriptor(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toolJsonSchema(tool.input),
    ...(tool.output ? { outputSchema: toolJsonSchema(tool.output) } : {}),
    annotations: tool.annotations,
  };
}

export interface CallToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const MAX_ISSUES = 10;

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * What the model is told when a tool fails. A refusal, a rejected statement,
 * a bad time expression or a rate limit name their cause, since those are the
 * caller's to fix; anything else is the server's and stays opaque.
 */
export function toolErrorMessage(err: unknown, tool: string): string {
  if (err instanceof HttpError) return err.message;
  if (
    err instanceof QueryExecutionError ||
    err instanceof VariableError ||
    err instanceof TimeRangeError
  ) {
    return err.message;
  }
  log.error("mcp.tool_failed", { tool, err });
  const requestId = currentRequest()?.requestId;
  return `the tool failed; the server log has the details${requestId ? ` (request ${requestId})` : ""}`;
}

/** Validate the arguments, run the tool, and report either way. */
export async function callTool(
  tool: McpTool,
  args: unknown,
  ctx: McpToolContext,
): Promise<CallToolResult> {
  const parsed = (tool.parse ?? tool.input).safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_ISSUES)
      .map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
      );
    return failure(`invalid arguments: ${issues.join("; ")}`);
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (err) {
    return failure(toolErrorMessage(err, tool.name));
  }
}
