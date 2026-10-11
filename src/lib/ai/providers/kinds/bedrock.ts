import { z } from "zod";
import {
  defineProviderKind,
  modelField,
  modelInput,
  PROVIDER_LIMITS,
  secretField,
} from "@/lib/ai/providers/types";

/** An AWS region name: `us-east-1`, `eu-central-2`, `us-gov-west-1`, `cn-north-1`. */
export const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** The Bedrock runtime host for a region, on AWS's own domain for its partition. */
export function bedrockOrigin(region: string): string {
  const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://bedrock-runtime.${region}.${suffix}`;
}

/**
 * Amazon Bedrock, signed with an access key pair (SigV4). The region is
 * typed, but the host it names is always AWS's, so there is no base URL to
 * guard. Instance roles and other cloud-identity credentials are out of
 * scope (#437): a stored model always carries its own key pair, and never
 * falls back to the server's.
 */
export const bedrockKind = defineProviderKind({
  kind: "bedrock",
  label: "Amazon Bedrock",
  description: "Foundation models on Amazon Bedrock, with an IAM access key.",
  docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
  settings: z
    .object({
      provider: z.literal("bedrock"),
      region: z
        .string()
        .trim()
        .toLowerCase()
        .regex(AWS_REGION, "must be an AWS region such as us-east-1"),
      model: modelField(),
    })
    .strict(),
  credentials: z
    .object({
      accessKeyId: secretField("enter the access key ID"),
      secretAccessKey: secretField("enter the secret access key"),
      sessionToken: z.string().trim().max(PROVIDER_LIMITS.secret).optional(),
    })
    .strict(),
  fields: [
    {
      name: "region",
      in: "settings",
      label: "Region",
      placeholder: "us-east-1",
      maxLength: 32,
    },
    modelInput("anthropic.claude-sonnet-4-20250514-v1:0"),
    {
      name: "accessKeyId",
      in: "credentials",
      label: "Access key ID",
      placeholder: "AKIA…",
      secret: true,
      maxLength: PROVIDER_LIMITS.secret,
    },
    {
      name: "secretAccessKey",
      in: "credentials",
      label: "Secret access key",
      secret: true,
      maxLength: PROVIDER_LIMITS.secret,
    },
    {
      name: "sessionToken",
      in: "credentials",
      label: "Session token",
      placeholder: "Only for temporary credentials",
      secret: true,
      optional: true,
      maxLength: PROVIDER_LIMITS.secret,
    },
  ],
  endpoint: (settings) => bedrockOrigin(settings.region),
  userSetsEndpoint: false,
});
