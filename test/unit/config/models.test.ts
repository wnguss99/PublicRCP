import {
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
  MODEL_DISPLAY_NAMES,
  isValidModel,
  getModelDisplayName,
  SupportedModel,
  MODEL_ALIASES,
  PINNED_MODELS,
} from '../../../src/config/models';

describe('Models Configuration', () => {
  describe('SUPPORTED_MODELS', () => {
    // 목록을 통째로 고정하면 모델을 추가할 때마다 깨진다. 실제로 매번 깨져서
    // "테스트는 원래 빨간 것" 이 되어버렸다. 스냅샷 대신 불변식을 검사한다.
    it('should have no duplicates', () => {
      expect(new Set(SUPPORTED_MODELS).size).toBe(SUPPORTED_MODELS.length);
    });

    it('should be exactly the aliases plus the pinned ids', () => {
      expect(SUPPORTED_MODELS).toEqual([...MODEL_ALIASES, ...PINNED_MODELS]);
    });

    it('should name an exact model for every pinned id', () => {
      PINNED_MODELS.forEach((model) => {
        expect(model).toMatch(/^claude-/);
        expect(MODEL_ALIASES).not.toContain(model);
      });
    });

    it('should treat aliases as aliases', () => {
      // 별칭은 CLI 가 '최신' 으로 풀어주는 값이라 claude- prefix 가 없다.
      // prefix 를 강제하면 별칭을 목록에 넣을 수 없다.
      MODEL_ALIASES.forEach((model) => {
        expect(model).not.toMatch(/^claude-/);
      });
    });

    it('should be readonly array', () => {
      expect(Array.isArray(SUPPORTED_MODELS)).toBe(true);
      expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_MODEL', () => {
    it('should be a supported model', () => {
      expect(SUPPORTED_MODELS).toContain(DEFAULT_MODEL);
    });

    it('should have a display name', () => {
      expect(MODEL_DISPLAY_NAMES[DEFAULT_MODEL]).toBeTruthy();
    });
  });

  describe('MODEL_DISPLAY_NAMES', () => {
    it('should have display names for all supported models', () => {
      SUPPORTED_MODELS.forEach((model: SupportedModel) => {
        expect(MODEL_DISPLAY_NAMES[model]).toBeDefined();
        expect(typeof MODEL_DISPLAY_NAMES[model]).toBe('string');
        expect(MODEL_DISPLAY_NAMES[model].length).toBeGreaterThan(0);
      });
    });

    it('should give every model a distinct, human readable name', () => {
      const names = SUPPORTED_MODELS.map((m: SupportedModel) => MODEL_DISPLAY_NAMES[m]);

      expect(new Set(names).size).toBe(names.length);

      // 별칭은 "Opus (latest)", 고정 모델은 "Claude Opus 5" 형태.
      // 사용자가 드롭다운에서 둘을 구분할 수 있어야 한다.
      MODEL_ALIASES.forEach((m) => expect(MODEL_DISPLAY_NAMES[m]).toMatch(/\(latest\)$/));
      PINNED_MODELS.forEach((m) => expect(MODEL_DISPLAY_NAMES[m]).toMatch(/^Claude /));
    });
  });

  describe('isValidModel', () => {
    it('should return true for supported models', () => {
      SUPPORTED_MODELS.forEach((model) => {
        expect(isValidModel(model)).toBe(true);
      });
    });

    it('should return false for unsupported models', () => {
      const unsupportedModels = [
        'claude-2',
        'gpt-4',
        'invalid-model',
        '',
        'claude-sonnet-3',
      ];

      unsupportedModels.forEach((model) => {
        expect(isValidModel(model)).toBe(false);
      });
    });

    it('should handle edge cases', () => {
      expect(isValidModel(null as any)).toBe(false);
      expect(isValidModel(undefined as any)).toBe(false);
      expect(isValidModel(123 as any)).toBe(false);
      expect(isValidModel({} as any)).toBe(false);
    });
  });

  describe('getModelDisplayName', () => {
    it('should return correct display names for supported models', () => {
      SUPPORTED_MODELS.forEach((model) => {
        const displayName = getModelDisplayName(model);
        expect(displayName).toBe(MODEL_DISPLAY_NAMES[model]);
      });
    });

    it('should return the input model for unsupported models', () => {
      const unsupportedModels = [
        'claude-2',
        'gpt-4',
        'invalid-model',
        'some-random-string',
      ];

      unsupportedModels.forEach((model) => {
        expect(getModelDisplayName(model)).toBe(model);
      });
    });

    it('should handle edge cases', () => {
      expect(getModelDisplayName('')).toBe('');
      expect(getModelDisplayName('   ')).toBe('   ');
    });
  });

  describe('Type safety', () => {
    it('should maintain type safety for SupportedModel', () => {
      // This test ensures TypeScript compilation works correctly
      const model: SupportedModel = PINNED_MODELS[0];
      expect(isValidModel(model)).toBe(true);

      const displayName: string = MODEL_DISPLAY_NAMES[model];
      expect(typeof displayName).toBe('string');
    });
  });
});