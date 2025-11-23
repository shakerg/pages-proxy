#!/usr/bin/env node
require('dotenv').config();

const key = process.env.GITHUB_APP_PRIVATE_KEY;

console.log('Private key length:', key?.length);
console.log('Contains literal \\n:', key?.includes('\\n'));
console.log('Contains actual newlines:', key?.includes('\n'));
console.log('\nFirst 200 chars:');
console.log(key?.substring(0, 200));
console.log('\nLast 100 chars:');
console.log(key?.substring(key.length - 100));
