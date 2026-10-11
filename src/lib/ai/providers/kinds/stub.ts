import { z } from "zod";
import { defineProviderKind, modelInput } from "@/lib/ai/providers/types";

/**
 * The recorded model (#88): answers from fixtures, never calls out. For the
 * end-to-end suite and local development; refused in production unless
 * `AI_STUB_IN_PRODUCTION` says that is what the server is, as the
 * environment's stub is.
 */
export const stubKind = defineProviderKind({
  kind: "stub",
  label: "Stub (recorded answers)",
  description: "Answers with recorded specs and never calls a model. For testing.",
  docsUrl: "https://github.com/jbouder/holotable/tree/main/e2e",
  settings: z
    .object({
      provider: z.literal("stub"),
      model: z.string().trim().max(200).default("stub"),
    })
    .strict(),
  credentials: z.object({}).strict(),
  // Optional: blank is "stub". Drawn so "List models" has a field to fill.
  fields: [{ ...modelInput("stub"), optional: true }],
  endpoint: () => null,
  userSetsEndpoint: false,
  developmentOnly: true,
  listsModels: true,
});
