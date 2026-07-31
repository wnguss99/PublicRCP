/**
 * Supported Claude models for agent execution.
 *
 * There are two kinds of entry, and the difference matters:
 *
 *   - Aliases ('opus', 'sonnet', 'haiku') — the Claude CLI resolves these to
 *     whatever it currently considers the newest model in that family. Picking
 *     one means a new release is adopted automatically the next time an agent
 *     starts; nobody has to edit this file. The trade-off is that the model can
 *     change under you, and it only tracks as far as the installed CLI knows:
 *     on CLI 2.1.116 `opus` still resolved to Opus 4.7, and only after updating
 *     to 2.1.220 did it resolve to Opus 5.
 *
 *   - Pinned ids ('claude-opus-5', ...) — exactly the model named, forever.
 *     Use these when a project must not shift underneath a long-running task.
 *
 * Adding a newly released model is two lines: the id here and its display name
 * below. Everything else (UI dropdowns, validation, per-project overrides)
 * derives from this file — see public/js/modules/model-catalog.js. The
 * "4b. 모델 목록 단일 출처" stage in scripts/validate.mjs keeps it that way.
 */

/** Resolved by the CLI to the newest model in the family at spawn time. */
export const MODEL_ALIASES = [
  'opus',
  'sonnet',
  'haiku',
] as const;

/** Exact models. Never shift. */
export const PINNED_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
] as const;

export const SUPPORTED_MODELS = [...MODEL_ALIASES, ...PINNED_MODELS] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/**
 * Defaults to the alias so a newly released Opus is picked up without a code
 * change. Pin this to a specific id (e.g. 'claude-opus-5') if you would rather
 * approve each model change yourself.
 */
export const DEFAULT_MODEL: SupportedModel = 'opus';

export const MODEL_DISPLAY_NAMES: Record<SupportedModel, string> = {
  opus: 'Opus (latest)',
  sonnet: 'Sonnet (latest)',
  haiku: 'Haiku (latest)',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

export function isValidModel(model: string): model is SupportedModel {
  return SUPPORTED_MODELS.includes(model as SupportedModel);
}

export function getModelDisplayName(model: string): string {
  if (isValidModel(model)) {
    return MODEL_DISPLAY_NAMES[model];
  }

  return model;
}
