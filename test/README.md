# Test Suite for Signal K to Venus OS Bridge

This directory contains comprehensive tests for the Signal K to Venus OS bridge plugin.

## Test Coverage

### Core Components
- **Tank Client** (`venusClient-tank.test.js`) - Tests tank sensor handling, D-Bus integration, and duplicate prevention
- **Switch Client** (`venusClient-switch.test.js`) - Tests switch/dimmer handling and state management  
- **Factory** (`venusClientFactory.test.js`) - Tests client creation and type routing
- **Settings** (`settings.test.js`) - Tests configuration validation and regex patterns
- **Main Plugin** (`index.test.js`) - Tests plugin lifecycle and Signal K integration

### Key Test Areas

#### 🔧 **D-Bus Integration**
- Interface export protection (prevents duplicate nodes)
- Stable device indexing (consistent IDs across restarts)
- Proper value wrapping and type conversion
- Venus OS Settings registration

#### 🚢 **Signal K Processing** 
- Path identification and validation
- Tank level/capacity/name handling
- Switch state and dimming level processing
- Invalid value rejection

#### 🛡️ **Error Handling**
- Connection failure recovery
- Graceful degradation
- Resource cleanup
- Invalid input handling

#### 📊 **Data Integrity**
- Consistent device naming
- Stable hash-based indexing
- Tank instance management
- Export deduplication

## Running Tests

### Prerequisites
```bash
cd test
npm install
```

### Test Commands
```bash
# Run all tests
npm test

# Watch mode (reruns on file changes)
npm run test:watch

# Coverage report
npm run test:coverage

# Interactive UI
npm run test:ui
```

### Test Structure
```
test/
├── venusClient-tank.test.js    # Tank client tests
├── venusClient-switch.test.js  # Switch client tests  
├── venusClientFactory.test.js  # Factory tests
├── settings.test.js            # Configuration tests
├── index.test.js              # Main plugin tests
├── setup.js                   # Global test setup
├── vitest.config.js           # Test configuration
└── package.json              # Test dependencies
```

## Test Philosophy

### ✅ **What We Test**
- **Critical business logic** - Tank indexing, name generation, value conversion
- **Integration points** - D-Bus export, Signal K processing, Settings registration
- **Edge cases** - Invalid inputs, connection failures, duplicate prevention
- **State management** - Instance tracking, export deduplication, cleanup

### ❌ **What We Don't Test**
- External dependencies (D-Bus, Signal K server)
- Network connectivity
- Venus OS specific behavior
- Real hardware integration

### 🎯 **Test Approach**
- **Unit tests** for individual functions and methods
- **Integration tests** for component interaction
- **Mock-heavy** to isolate units under test
- **Behavior-driven** testing over implementation details

## Critical Test Scenarios

### Tank Client Tests
```javascript
// Stable indexing (prevents D-Bus node duplication)
it('should generate same index for same path', () => {
  const index1 = client._generateStableIndex('tanks.fuel.starboard');
  const index2 = client._generateStableIndex('tanks.fuel.starboard');
  expect(index1).toBe(index2);
});

// Export protection (fixes duplicate interface issue)
it('should export interface only once per path', () => {
  client._exportProperty('/Tank/1/Level', config);
  client._exportProperty('/Tank/1/Level', newConfig);
  expect(mockBus.exportInterface).toHaveBeenCalledTimes(1);
});
```

### Switch Client Tests
```javascript
// Value conversion
it('should handle switch state updates correctly', async () => {
  await client.handleSignalKUpdate('electrical.switches.nav.state', true);
  expect(client._exportProperty).toHaveBeenCalledWith(
    '/Switch/456/State',
    expect.objectContaining({ value: 1 }) // true -> 1
  );
});
```

## Expected Test Results

When all tests pass, you can be confident that:

1. **D-Bus node duplication is prevented** ✅
2. **Device indexing is stable and consistent** ✅  
3. **Signal K data is properly converted and validated** ✅
4. **Error handling is robust** ✅
5. **Resource cleanup works correctly** ✅
6. **Venus OS Settings integration functions** ✅

## Debugging Failed Tests

### Common Issues
- **Mock setup problems** - Check that all dependencies are properly mocked
- **Async test issues** - Ensure proper await/async handling
- **Import errors** - Verify mock paths match actual file structure
- **State pollution** - Check that tests properly reset between runs

### Debug Commands
```bash
# Run specific test file
npx vitest venusClient-tank.test.js

# Run with debug output  
npx vitest --reporter=verbose

# Run single test
npx vitest -t "should generate same index"
```

This test suite ensures the plugin's critical functionality remains stable and bug-free across development and deployment.
