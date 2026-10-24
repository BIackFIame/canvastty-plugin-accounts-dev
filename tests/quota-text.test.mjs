// What the Accounts page says about an account's quota: the used share and what is left, in both languages. The
// quota view keeps the percent left; a provider that reports 9 % used (Codex usedPercent 9) is "9 % used · 91 % left".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { quotaShareText } from '../src/shared/quotaText.ts';
import { emptyRecord, observe, viewOf } from '../src/quota/model.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

test('a quota line states both the used share and what is left (ru/en)', () => {
  assert.equal(quotaShareText('en', 91, '5h'), '9% used · 91% left (5h)');
  assert.equal(quotaShareText('ru', 91, '5h'), 'использовано 9% · осталось 91% (5h)');
  assert.equal(quotaShareText('ru', 87.5), 'использовано 12,5% · осталось 87,5%');
  assert.equal(quotaShareText('en', 0), '100% used · 0% left');
  assert.equal(quotaShareText('en', 140), '0% used · 100% left');
});

test('a Codex window with usedPercent 9 becomes 91 % left, and its note says 9 % used', () => {
  const record = observe(emptyRecord(), { source: 'core-limits', at: NOW, windows: [
    { id: 'codex:primary', label: '5h', usedPercent: 9, used: null, limit: null, windowMinutes: 300, resetsAt: NOW + 3_600_000, models: true }
  ] }, NOW).record;
  const view = viewOf(record, NOW);
  assert.equal(view.remainingPercent, 91);
  assert.match(view.note, /^5h: 9% used, 91% left/u);
  assert.equal(quotaShareText('ru', view.remainingPercent, view.window), 'использовано 9% · осталось 91% (5h)');
});

test('the settings page bundle has no bare "N% left" / "осталось N%" line any more', () => {
  const page = readFileSync(new URL('../settings/accounts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /`\$\{percent\}% left/u);
  assert.doesNotMatch(page, /\\u043E\\u0441\\u0442\\u0430\\u043B\\u043E\\u0441\\u044C \$\{percent\}%|осталось \$\{percent\}%/u);
  assert.match(page, /used ·|\\u0438\\u0441\\u043F\\u043E\\u043B\\u044C\\u0437\\u043E\\u0432\\u0430\\u043D\\u043E|использовано/u);
});
