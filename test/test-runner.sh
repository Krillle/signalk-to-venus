#!/bin/bash

# Test runner to check fixes
echo "Running tests with fixes..."

cd "$(dirname "$0")"

# Run just one test file first to check if fixes work
npm test -- --run venusClient-tank.test.js --reporter=verbose 2>&1 | head -100
