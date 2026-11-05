import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseInstant, millisecondInstant } from '../src/core/date-time-input.ts';

test('database timestamps retain native cursor precision and reject unsupported cast inputs', () => {
  for (const value of ['0001-01-01T00:00:00Z', '9999-12-31T23:59:59Z',
    '2026-01-03T04:30:00.123456+00:00', '2026-01-03T04:30:00+15:59']) {
    assert.equal(databaseInstant.parse(value), value);
  }
  for (const value of ['0000-01-01T00:00:00Z', '0001-01-01T00:00:00+15:00',
    '9999-12-31T23:59:59-15:00', '2026-01-03T04:30:00+20:00',
    '2026-01-03T04:30:00.1234567Z', '2026-02-30T04:30:00Z', 'infinity']) {
    assert.equal(databaseInstant.safeParse(value).success, false, value);
  }
  assert.equal(millisecondInstant.parse('2026-01-03T04:30:00.123Z'), '2026-01-03T04:30:00.123Z');
  assert.equal(millisecondInstant.safeParse('2026-01-03T04:30:00.1234Z').success, false);
});
