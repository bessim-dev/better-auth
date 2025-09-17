#!/usr/bin/env node

// Simple validation script to check metered billing implementation
const fs = require('fs');
const path = require('path');

function checkFile(filePath, checks) {
  console.log(`Checking ${filePath}...`);
  
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return false;
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  let allPassed = true;
  
  checks.forEach(check => {
    if (check.type === 'contains') {
      if (content.includes(check.text)) {
        console.log(`✅ Contains: "${check.text}"`);
      } else {
        console.log(`❌ Missing: "${check.text}"`);
        allPassed = false;
      }
    } else if (check.type === 'regex') {
      if (check.pattern.test(content)) {
        console.log(`✅ Pattern matches: ${check.pattern}`);
      } else {
        console.log(`❌ Pattern does not match: ${check.pattern}`);
        allPassed = false;
      }
    }
  });
  
  return allPassed;
}

const baseDir = './packages/stripe/src/';

console.log('🔍 Validating metered billing implementation...\n');

// Check types.ts for metered property
const typesChecks = [
  { type: 'contains', text: 'metered?: boolean;' },
  { type: 'contains', text: 'metered billing' },
  { type: 'contains', text: '@default false' }
];

// Check index.ts for conditional quantity logic
const indexChecks = [
  { type: 'contains', text: '...(plan.metered ? {} : { quantity: ctx.body.seats || 1 })' },
  { type: 'contains', text: '...(plan.metered ? {} : { seats: ctx.body.seats || 1 })' },
  { type: 'regex', pattern: /plan\.metered.*\?\s*\{\}\s*:\s*\{.*quantity/ }
];

// Check hooks.ts for conditional seats logic
const hooksChecks = [
  { type: 'contains', text: '...(plan.metered ? {} : { seats })' },
  { type: 'contains', text: '...(plan?.metered ? {} : { seats })' }
];

let allValid = true;

allValid &= checkFile(path.join(baseDir, 'types.ts'), typesChecks);
console.log('');

allValid &= checkFile(path.join(baseDir, 'index.ts'), indexChecks);
console.log('');

allValid &= checkFile(path.join(baseDir, 'hooks.ts'), hooksChecks);
console.log('');

if (allValid) {
  console.log('🎉 All validation checks passed!');
  process.exit(0);
} else {
  console.log('❌ Some validation checks failed.');
  process.exit(1);
}