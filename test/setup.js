// Test setup file for global mocks and configurations
import { vi } from 'vitest';

// Global mock for console methods to reduce noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Global test timeout
vi.setConfig({ testTimeout: 10000 });

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});
