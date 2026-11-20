import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebsiteOrigin } from '../src/site.ts';

test('website configuration accepts an exact HTTPS origin, not redirect or credential input', () => {
  assert.equal(parseWebsiteOrigin('https://example.com/'), 'https://example.com');
  for (const value of ['http://example.com', 'https://name:pass@example.com',
    'https://example.com:444', 'https://example.com/path', 'https://example.com/?q=x', 'https://example.com/#x']) {
    assert.throws(() => parseWebsiteOrigin(value));
  }
});
