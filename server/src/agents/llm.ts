import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./prompts.ts";

// The one place the server talks to Claude. Everything else depends on the
// JsonModel shape, so tests swap in a fake and never touch the network.

export interface JsonRequest {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort: Effort;
  maxTokens: number;
}

export type JsonResult =
  | { ok: true; json: unknown; model: string }
  // refusal and max_tokens are model outcomes, not errors: the pipeline
  // escalates the case to a person instead of failing.
  | { ok: false; reason: string };

export type JsonModel = (req: JsonRequest) => Promise<JsonResult>;

export function anthropicJsonModel(apiKey: string): JsonModel {
  const client = new Anthropic({ apiKey });
  return async (req) => {
    const response = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      // The rules text is the same on every call for a department: cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
      // On a policy decline the API retries on the model's default fallback;
      // where a model has none, the request just runs on that model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      return { ok: false, reason: `the model declined (${response.stop_details?.category ?? "no category"})` };
    }
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "the model ran out of tokens" };
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      return { ok: true, json: JSON.parse(text), model: response.model };
    } catch {
      return { ok: false, reason: "the model's answer was not valid JSON" };
    }
  };
}
