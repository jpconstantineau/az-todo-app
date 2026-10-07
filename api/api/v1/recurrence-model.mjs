import { ValidationError, utcDate } from '../shared/validate.mjs';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateFromParts = (year, month, day) => { const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day); return date; };

export function recurrenceDate(value, field = 'date') {
  const match = typeof value === 'string' && DATE.exec(value);
  if (!match) throw new ValidationError(`${field} must be a calendar date.`);
  const [year, month, day] = match.slice(1).map(Number);
  const date = dateFromParts(year, month, day);
  if (!year || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValidationError(`${field} must be a valid calendar date.`);
  }
  return value;
}

export function recurrenceZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new ValidationError('timeZone must be a supported IANA timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new ValidationError('timeZone must be a supported IANA timezone.'); }
  return value;
}

export function recurrenceRule(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['mode', 'unit', 'interval', 'anchorDate', 'timeZone'].includes(key))) {
    throw new ValidationError('rule must contain mode, unit, interval, anchorDate and timeZone.');
  }
  if (!['fixed', 'after-resolution'].includes(value.mode)) throw new ValidationError('rule.mode must be fixed or after-resolution.');
  if (!['day', 'week', 'month'].includes(value.unit)) throw new ValidationError('rule.unit must be day, week or month.');
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 999) throw new ValidationError('rule.interval must be an integer from 1 to 999.');
  return { mode: value.mode, unit: value.unit, interval: value.interval,
    anchorDate: recurrenceDate(value.anchorDate, 'rule.anchorDate'), timeZone: recurrenceZone(value.timeZone) };
}

const parts = value => value.split('-').map(Number);
const compareDates = (left, right) => { const a = parts(left), b = parts(right); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; };
const iso = date => `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

export function addRecurrenceUnits(value, unit, amount, anchorDay = parts(value)[2]) {
  recurrenceDate(value); if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidationError('Recurrence offset must be a non-negative integer.');
  const [year, month, day] = parts(value);
  if (unit === 'month') {
    const first = dateFromParts(year, month + amount, 1);
    const last = dateFromParts(first.getUTCFullYear(), first.getUTCMonth() + 2, 0).getUTCDate();
    first.setUTCDate(Math.min(anchorDay, last)); return iso(first);
  }
  if (!['day', 'week'].includes(unit)) throw new ValidationError('Recurrence unit is unsupported.');
  return iso(dateFromParts(year, month, day + amount * (unit === 'week' ? 7 : 1)));
}

export function zonedDate(instant, timeZone) {
  recurrenceZone(timeZone);
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new ValidationError('resolved UTC must be valid.');
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function fixedDate(rule, occurrenceNumber) {
  rule = recurrenceRule(rule);
  if (!Number.isSafeInteger(occurrenceNumber) || occurrenceNumber < 1) throw new ValidationError('occurrenceNumber must be positive.');
  return addRecurrenceUnits(rule.anchorDate, rule.unit, (occurrenceNumber - 1) * rule.interval, parts(rule.anchorDate)[2]);
}

export function latestFixedDate(rule, onOrBefore) {
  rule = recurrenceRule(rule); recurrenceDate(onOrBefore, 'onOrBefore');
  if (compareDates(onOrBefore, rule.anchorDate) < 0) return rule.anchorDate;
  let low = 0, high = 1;
  while (compareDates(addRecurrenceUnits(rule.anchorDate, rule.unit, high * rule.interval, parts(rule.anchorDate)[2]), onOrBefore) <= 0) high *= 2;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareDates(addRecurrenceUnits(rule.anchorDate, rule.unit, middle * rule.interval, parts(rule.anchorDate)[2]), onOrBefore) <= 0) low = middle;
    else high = middle;
  }
  return addRecurrenceUnits(rule.anchorDate, rule.unit, low * rule.interval, parts(rule.anchorDate)[2]);
}

export function nextAfterResolution(rule, resolvedUtc) {
  rule = recurrenceRule(rule); const resolved = utcDate(resolvedUtc);
  const resolvedDate = zonedDate(resolved, rule.timeZone);
  if (rule.mode === 'after-resolution') return addRecurrenceUnits(resolvedDate, rule.unit, rule.interval, parts(resolvedDate)[2]);
  if (compareDates(resolvedDate, rule.anchorDate) < 0) return rule.anchorDate;
  let low = 0, high = 1;
  while (compareDates(addRecurrenceUnits(rule.anchorDate, rule.unit, high * rule.interval, parts(rule.anchorDate)[2]), resolvedDate) <= 0) high *= 2;
  while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (compareDates(addRecurrenceUnits(rule.anchorDate, rule.unit, middle * rule.interval, parts(rule.anchorDate)[2]), resolvedDate) <= 0) low = middle; else high = middle; }
  return addRecurrenceUnits(rule.anchorDate, rule.unit, high * rule.interval, parts(rule.anchorDate)[2]);
}

function hash(value) {
  let result = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) { result ^= BigInt(byte); result = BigInt.asUintN(64, result * 0x100000001b3n); }
  return result.toString(16).padStart(16, '0');
}

export function occurrenceId(templateId, number) {
  if (typeof templateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(templateId)) throw new ValidationError('templateId is invalid.');
  if (!Number.isSafeInteger(number) || number < 1) throw new ValidationError('occurrenceNumber must be positive.');
  return `rec-${hash(templateId)}-${number.toString(36)}`;
}

export function materializationDate(template, now = new Date()) {
  if (template.paused || template.tombstoned || template.openOccurrenceId) return null;
  const today = zonedDate(now, template.rule.timeZone);
  if (template.nextIntendedDate > today) return null;
  return template.rule.mode === 'fixed' ? latestFixedDate(template.rule, today) : template.nextIntendedDate;
}

export function recurrenceSnapshot(template) {
  return Object.fromEntries(['title', 'description', 'workspaceId', 'collectionRefs', 'listId', 'projectId', 'status', 'contexts', 'areas', 'energy', 'timeRequired', 'priority', 'referenceLinks']
    .map(name => [name, structuredClone(template[name])])) ;
}
