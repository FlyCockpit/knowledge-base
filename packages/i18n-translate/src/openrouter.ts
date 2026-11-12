import { env } from "@knowledge-base/env/shared";
import OpenAI from "openai";
import { buildTranslationPrompt } from "./prompt.js";
import type { TranslateInput, TranslateResult, TranslationProvider } from "./types.js";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
// Raised from 8192 so long pages translate without hitting the output
// cap. Clamped to 64000 (not the requested 65536) because the default model,
// Claude Haiku 4.5, has a hard 64K output-token ceiling — a higher max_tokens
// is rejected upstream. Larger-output models routed via TRANSLATION_MODEL
// still get the full 64K.
const MAX_OUTPUT_TOKENS = 64000;

export class OpenRouterProvider implements TranslationProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    const defaultHeaders: Record<string, string> = {
      "X-Title": "knowledge-base Translation",
    };
    // OpenRouter uses HTTP-Referer purely to attribute traffic on its
    // leaderboard — it is optional metadata, not functional. PUBLIC_APP_URL is
    // the stable public origin; fall back to the raw BETTER_AUTH_URL from
    // process.env (set in the server process, absent in the worker — the
    // header is simply omitted there). Both are read off process.env directly
    // so this provider stays in the worker-safe env graph and never forces a
    // worker deployment to set BETTER_AUTH_URL.
    const referer = env.PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
    if (referer) defaultHeaders["HTTP-Referer"] = referer;

    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders,
      // The SDK already retries 429s and transient 5xx with exponential
      // backoff, honoring `retry-after`. **Do not add a retry loop around
      // `translate()`** — it would multiply against this one and turn a brief
      // provider rate-limit into a long stall. Raised from the default 2
      // because bulk auto-translate runs many calls back to back and reliably
      // brushes provider limits. BullMQ's `attempts: 3` is the last resort
      // above this.
      maxRetries: 4,
    });
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const model = input.model ?? env.TRANSLATION_MODEL ?? DEFAULT_MODEL;
    const { system, user } = buildTranslationPrompt({
      source: input.source,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      contentKind: input.contentKind,
    });

    const completion = await this.client.chat.completions.create({
      model,
      // Deterministic translations — re-running the worker for the same source
      // should produce the same target, otherwise diff review becomes useless.
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const choice = completion.choices[0];
    if (choice?.finish_reason === "length") {
      throw new Error(
        `[i18n-translate] OpenRouter truncated the translation at the output limit (model=${completion.model ?? model})`,
      );
    }

    const text = choice?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`[i18n-translate] OpenRouter returned an empty completion (model=${model})`);
    }

    return {
      text,
      // OpenRouter echoes the resolved model id in `completion.model`, which
      // can differ from the requested one when a model id aliases a family.
      // Pass it through so callers that need the actually-used model have it.
      model: completion.model ?? model,
    };
  }
}
