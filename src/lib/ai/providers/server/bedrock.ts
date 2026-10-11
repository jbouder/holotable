import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { bedrockKind, bedrockOrigin } from "@/lib/ai/providers/kinds/bedrock";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const bedrockServer = defineServerKind(bedrockKind, {
  kind: "bedrock",
  providerOptions: {},
  build(settings, credentials, fetch) {
    return createAmazonBedrock({
      region: settings.region,
      baseURL: bedrockOrigin(settings.region),
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      // Explicit even when absent: with both keys passed the SDK reads the
      // token from here only, never AWS_SESSION_TOKEN.
      sessionToken: credentials.sessionToken,
      // A blank key, not undefined: the SDK reads AWS_BEARER_TOKEN_BEDROCK
      // when this is undefined and would sign with the server's bearer token.
      // Blank, it falls through to SigV4 with the pair above.
      apiKey: " ",
      fetch,
    })(settings.model);
  },
});
