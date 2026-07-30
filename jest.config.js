/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Redirects CLAUDITO_HOME to a temp dir before any module loads, so tests
  // cannot write into a live instance's data directory.
  setupFiles: ['<rootDir>/test/env-setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // Force-exit after all tests complete to avoid waiting on background async
  // operations (e.g. child processes from claudeCliService, ralph-loop callbacks).
  forceExit: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
