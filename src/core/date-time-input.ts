import { z } from 'zod';

// PostgreSQL cursors retain microseconds; JavaScript date comparisons only
// retain milliseconds. Reject unsupported values before any database cast.
export const databaseInstant = z.iso.datetime({ offset: true }).max(40).refine(v =>
  !v.startsWith('0000-') && !/[.]\d{7}/.test(v) &&
  !/[+-](1[6-9]|2[0-3]):\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) &&
  new Date(v).getUTCFullYear() >= 1 && new Date(v).getUTCFullYear() <= 9999,
  'Unsupported timestamp range or precision');

export const millisecondInstant = databaseInstant.refine(v => !/[.]\d{4}/.test(v),
  'Timestamp precision exceeds milliseconds');
