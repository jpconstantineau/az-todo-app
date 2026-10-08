import { isCollection, memberships, refKey } from './collection-model.js?v=4';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const linkedRecord = record => ['item', 'recurrenceTemplate'].includes(record.type);
const relationshipFields = record => linkedRecord(record)
  ? { collectionRefs: memberships(record), listId: record.listId || null, projectId: record.projectId || null }
  : { parentRef: record.parentRef || null };
const detachedFields = record => linkedRecord(record)
  ? { collectionRefs: [], listId: null, projectId: null }
  : { parentRef: null };

function movingRecords(record, records) {
  const moving = new Set([refKey(record)]);
  let previousSize;
  do {
    previousSize = moving.size;
    for (const candidate of Object.values(records)) {
      if (isCollection(candidate) && !candidate.deleted && candidate.parentRef && moving.has(refKey(candidate.parentRef))) moving.add(refKey(candidate));
    }
  } while (moving.size !== previousSize);
  const selected = Object.values(records).filter(candidate => !candidate.deleted &&
    (moving.has(refKey(candidate)) || (candidate.type === 'item' && !candidate.recurrenceTemplateId || candidate.type === 'recurrenceTemplate' && !candidate.tombstoned) && memberships(candidate).some(ref => moving.has(refKey(ref)))));
  const recurrenceIds = new Set(selected.filter(candidate => candidate.type === 'recurrenceTemplate').map(candidate => candidate.id));
  return Object.values(records).filter(candidate => !candidate.deleted && (selected.includes(candidate) || candidate.type === 'recurrenceTemplate' && recurrenceIds.has(candidate.id) || candidate.type === 'item' && recurrenceIds.has(candidate.recurrenceTemplateId)))
    .sort((left, right) => (left.type === 'recurrenceTemplate' ? -1 : right.type === 'recurrenceTemplate' ? 1 : refKey(left).localeCompare(refKey(right))));
}

function finalFields(candidate, root, workspaceId, moving, fields) {
  let relationships;
  if (linkedRecord(candidate)) {
    const collectionRefs = memberships(candidate).filter(ref => moving.has(refKey(ref)));
    relationships = { collectionRefs,
      listId: collectionRefs.some(ref => ref.type === 'list' && ref.id === candidate.listId) ? candidate.listId : collectionRefs.find(ref => ref.type === 'list')?.id || null,
      projectId: collectionRefs.some(ref => ref.type === 'project' && ref.id === candidate.projectId) ? candidate.projectId : collectionRefs.find(ref => ref.type === 'project')?.id || null };
  } else relationships = { parentRef: candidate.parentRef && moving.has(refKey(candidate.parentRef)) ? candidate.parentRef : null };
  return { ...(refKey(candidate) === refKey(root) ? fields : {}), ...relationships, workspaceId };
}

export function collectionMoveMutations(record, workspaceId, records, fields) {
  const dependents = movingRecords(record, records);
  if (dependents.length > 20) throw new Error('This collection is too large for one atomic move.');
  const moving = new Set(dependents.filter(isCollection).map(refKey));
  return dependents.map(candidate => ({ type: candidate.type, id: candidate.id, action: 'update', expectedVersion: candidate.version,
    fields: finalFields(candidate, record, workspaceId, moving, fields) }));
}

export function collectionMovePlan(record, workspaceId, records, fields, id = crypto.randomUUID()) {
  const dependents = movingRecords(record, records);
  if (dependents.length <= 20) return null;
  const moving = new Set(dependents.filter(isCollection).map(refKey));
  return {
    version: 1, id, phase: 'detach', step: 0,
    root: { type: record.type, id: record.id }, sourceWorkspaceId: record.workspaceId, destinationWorkspaceId: workspaceId,
    entries: dependents.map(candidate => ({ type: candidate.type, id: candidate.id,
      final: finalFields(candidate, record, workspaceId, moving, fields) })), skipped: []
  };
}

function activeEntries(plan, records) {
  const skipped = new Set(plan.skipped || []);
  for (const entry of plan.entries) {
    const id = refKey(entry), record = records[id];
    if ((!record || record.deleted) && id !== refKey(plan.root)) skipped.add(id);
  }
  plan.skipped = [...skipped].sort();
  const root = records[refKey(plan.root)];
  if (!root || root.deleted) throw new Error('Move paused because the root collection was deleted. Restore it before resuming.');
  return plan.entries.filter(entry => !skipped.has(refKey(entry)));
}

function targetFields(entry, active) {
  const keys = new Set(active.map(refKey));
  if (!['item', 'recurrenceTemplate'].includes(entry.type)) {
    const parentRef = entry.final.parentRef && keys.has(refKey(entry.final.parentRef)) ? entry.final.parentRef : null;
    return { ...entry.final, parentRef };
  }
  const collectionRefs = entry.final.collectionRefs.filter(ref => keys.has(refKey(ref)));
  return { ...entry.final, collectionRefs,
    listId: collectionRefs.some(ref => ref.type === 'list' && ref.id === entry.final.listId) ? entry.final.listId : collectionRefs.find(ref => ref.type === 'list')?.id || null,
    projectId: collectionRefs.some(ref => ref.type === 'project' && ref.id === entry.final.projectId) ? entry.final.projectId : collectionRefs.find(ref => ref.type === 'project')?.id || null };
}

export function projectCollectionMove(records, plan) {
  if (!plan) return records;
  const active = plan.entries.filter(entry => {
    const record = records[refKey(entry)];
    return record && !record.deleted && !(plan.skipped || []).includes(refKey(entry));
  });
  for (const entry of active) Object.assign(records[refKey(entry)], targetFields(entry, active), { localState: 'Saved on device — move pending' });
  return records;
}

function desiredFields(plan, entry, active) {
  if (plan.phase === 'detach') return detachedFields(entry);
  if (plan.phase === 'move') return { workspaceId: plan.destinationWorkspaceId };
  const { workspaceId, ...fields } = targetFields(entry, active);
  return fields;
}

function phaseComplete(plan) {
  plan.phase = plan.phase === 'detach' ? 'move' : plan.phase === 'move' ? 'attach' : 'complete';
}

export function nextCollectionMoveOperation(plan, records, accountId, maxBytes = Infinity) {
  while (plan.phase !== 'complete') {
    const active = activeEntries(plan, records), pending = [];
    for (const entry of active) {
      const record = records[refKey(entry)], fields = desiredFields(plan, entry, active);
      if (Object.entries(fields).every(([name, value]) => same(record[name] ?? null, value))) continue;
      if (plan.phase === 'move' && !same(relationshipFields(record), detachedFields(record))) {
        throw new Error('Move paused because collection relationships changed after preparation. Review them, then resume.');
      }
      if (plan.phase === 'attach' && (record.workspaceId !== plan.destinationWorkspaceId || !same(relationshipFields(record), detachedFields(record)))) {
        throw new Error('Move paused because a record changed before relationships were restored. Review it, then resume.');
      }
      pending.push({ type: entry.type, id: entry.id, action: 'update', expectedVersion: record.version, fields });
    }
    if (!pending.length) { phaseComplete(plan); continue; }
    const operationId = `${plan.id}-${String(plan.step + 1).padStart(4, '0')}`, chunk = [];
    for (const mutation of pending.slice(0, 20)) {
      const candidate = { apiVersion: 1, accountId, operationId, mutations: [...chunk, mutation] };
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > maxBytes) {
        if (!chunk.length) throw new Error('Move paused because one record change exceeds the cloud operation size limit.');
        break;
      }
      chunk.push(mutation);
    }
    plan.step++;
    return { operation: { apiVersion: 1, accountId, operationId, mutations: chunk }, phase: plan.phase };
  }
  return null;
}
