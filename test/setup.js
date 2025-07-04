// Test setup file for global mocks and configurations
import { vi } from 'vitest';

// Global mock for console methods to reduce noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  // Only log if it's not a test-related DNS error
  if (!reason?.message?.includes('ENOTFOUND test.local')) {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  }
});
