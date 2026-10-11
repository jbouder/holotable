import { stubKind } from "@/lib/ai/providers/kinds/stub";
import { defineServerKind } from "@/lib/ai/providers/server/types";
import { stubModel } from "@/lib/ai/stub";

export const stubServer = defineServerKind(stubKind, {
  kind: "stub",
  providerOptions: {},
  build: () => stubModel(),
});
