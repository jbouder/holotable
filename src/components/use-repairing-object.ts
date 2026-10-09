"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import type { FlexibleSchema, InferSchema } from "ai";
import * as React from "react";
import type { z } from "zod";
import { GENERATION_ID_HEADER } from "@/lib/ai/generation-id";
import {
  LINK_TARGETS_HEADER,
  parseLinkTargetsHeader,
  unknownLinkTargets,
} from "@/lib/ai/link-targets";

/** What the browser shows when the repair did not validate either. */
export const REPAIR_FAILED =
  "The model's answer was not in the expected format, even after one automatic fix. Try again, or rephrase the request.";

type Options<SCHEMA extends FlexibleSchema, RESULT> = Parameters<
  typeof useObject<SCHEMA, RESULT>
>[0];

/**
 * `useObject` with the one automatic repair (#21).
 *
 * A generation streams in as usual. If its finished output fails the schema
 * and the response named the generation (`X-Generation-Id`), this asks the
 * same route for a repair, `{ repairOf: id }`, once; the server re-asks the
 * model with what was wrong and the repaired output streams in its place.
 * `onFinish` is held back until the outcome is final, so a surface sees one
 * finish per author action, and `isLoading` stays true across the hand-off.
 *
 * The repair's own failure is final and becomes `error`, so a surface shows
 * it with Try again rather than sitting on an invalid preview. `repairing` is
 * true while the repair streams, for a surface to say so.
 */
export function useRepairingObject<
  SCHEMA extends FlexibleSchema,
  RESULT = InferSchema<SCHEMA>,
  INPUT = unknown,
>(options: Options<SCHEMA, RESULT>) {
  const generationId = React.useRef<string | null>(null);
  // The dashboards this generation's links may name (#375), from the
  // response. The schema below refuses any other, as the route does, so a
  // link to an invented id is repaired rather than shown.
  const linkTargets = React.useRef<string[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the schema is the caller's constant; the targets are read through a ref
  const schema = React.useMemo(() => withLinkTargetsRef(options.schema, linkTargets), []);
  // Refs, not state, for what onFinish reads: it runs from inside the stream
  // and must see the values of this run, not of the render that started it.
  const repairingRef = React.useRef(false);
  const [repairing, setRepairing] = React.useState(false);
  const [failure, setFailure] = React.useState<Error | undefined>(undefined);
  const { onFinish, fetch: baseFetch } = options;

  const settle = () => {
    repairingRef.current = false;
    setRepairing(false);
  };

  const base = useObject<SCHEMA, RESULT, INPUT | { repairOf: string }>({
    ...options,
    schema,
    fetch: async (input, init) => {
      const response = await (baseFetch ?? fetch)(input, init);
      generationId.current = response.headers.get(GENERATION_ID_HEADER);
      linkTargets.current = parseLinkTargetsHeader(
        response.headers.get(LINK_TARGETS_HEADER),
      );
      return response;
    },
    onFinish: async (event) => {
      const id = generationId.current;
      generationId.current = null;
      if (event.object === undefined && id && !repairingRef.current) {
        repairingRef.current = true;
        setRepairing(true);
        base.submit({ repairOf: id });
        return;
      }
      const repaired = repairingRef.current;
      settle();
      if (event.object === undefined && repaired) setFailure(new Error(REPAIR_FAILED));
      await onFinish?.(event);
    },
    onError: (error) => {
      settle();
      options.onError?.(error);
    },
  });

  const submit = (input: INPUT) => {
    generationId.current = null;
    settle();
    setFailure(undefined);
    base.submit(input);
  };

  const stop = () => {
    settle();
    base.stop();
  };

  const clear = () => {
    settle();
    setFailure(undefined);
    base.clear();
  };

  return {
    ...base,
    submit,
    stop,
    clear,
    isLoading: base.isLoading || repairing,
    error: base.error ?? failure,
    repairing,
  };
}

/**
 * The caller's schema, refusing a link to a dashboard the response did not
 * list (#375). A schema that is not zod, or a response with no list, is
 * left as it is.
 */
function withLinkTargetsRef<SCHEMA extends FlexibleSchema>(
  schema: SCHEMA,
  targets: React.RefObject<string[] | null>,
): SCHEMA {
  const zod = schema as unknown as Partial<z.ZodType>;
  if (typeof zod.superRefine !== "function") return schema;
  return zod.superRefine((value, ctx) => {
    const allowed = targets.current;
    if (allowed === null) return;
    for (const bad of unknownLinkTargets(value, allowed)) {
      ctx.addIssue({
        code: "custom",
        message: `link "${bad.title}" names a dashboard that was not offered`,
      });
    }
  }) as unknown as SCHEMA;
}
