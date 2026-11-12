import Anthropic from "@anthropic-ai/sdk";
import { env } from "@knowledge-base/env/shared";
import { buildTranslationPrompt } from "./prompt.js";
import type { TranslateInput, TranslateResult, TranslationProvider } from "./types.js";

const DEFAULT_MODEL = "claude-haiku-4-5";

// Raised from 8192 so long pages translate without hitting the output
// cap. Clamped to 64000 (not the requested 65536) because the default model,
// Claude Haiku 4.5, has a hard 64K output-token ceiling — the Anthropic API
// returns a 400 for max_tokens above the model's limit.
const MAX_OUTPUT_TOKENS = 64000;

export class AnthropicDirectProvider implements TranslationProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    // The SDK already retries 429s and transient 5xx with exponential backoff,
    // honoring `retry-after` / `retry-after-ms`. **Do not add a retry loop
    // around `translate()`** — it would multiply against this one and turn a
    // brief provider rate-limit into a long stall. Raised from the default 2
    // because bulk auto-translate (a locale sweep
    // to every target language) runs many calls back to back and reliably
    // brushes provider limits; four attempts absorbs that without the job
    // failing. BullMQ's own `attempts: 3` sits above this as the last resort.
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const model = input.model ?? env.TRANSLATION_MODEL ?? DEFAULT_MODEL;
    const { system, user } = buildTranslationPrompt({
      source: input.source,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      contentKind: input.contentKind,
    });

    const response = await this.client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // API version 2026-10-21 (SDK 1.x) no longer accepts sampling parameters.
      system,
      messages: [{ role: "user", content: user }],
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `[i18n-translate] Anthropic truncated the translation at max_tokens (model=${response.model ?? model})`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (text.length === 0) {
      throw new Error(`[i18n-translate] Anthropic returned an empty completion (model=${model})`);
    }

    return {
      text,
      model: response.model ?? model,
    };
  }
}
