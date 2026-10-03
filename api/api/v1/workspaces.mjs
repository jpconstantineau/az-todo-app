import { ValidationError } from '../shared/validate.mjs';

const fail = message => { throw new ValidationError(message); };
export async function workspaceOf(record, lookup) {
  if (record?.type === 'clarification') return (await lookup('item', record.id))?.workspaceId || 'personal';
  if (record?.type === 'brief') return (await lookup(record.subjectType, record.subjectId))?.workspaceId || 'personal';
  return record?.workspaceId || 'personal';
}

export async function validateWorkspace(record, old, lookup) {
  if (record.type === 'settings' || record.type === 'workspace') return;
  const workspaceId = await workspaceOf(record, lookup);
  const writable = async id => {
    if (id === 'personal') return;
    const workspace = await lookup('workspace', id);
    if (!workspace || workspace.deleted || workspace.archived) fail('This workspace is unavailable or archived. Restore or unarchive it before saving.');
  };
  await writable(workspaceId);
  if (old) await writable(await workspaceOf(old, lookup));
  if (record.type === 'item' && !record.deleted) {
    for (const type of ['list', 'project']) {
      const parent = record[`${type}Id`] && await lookup(type, record[`${type}Id`]);
      if (parent && await workspaceOf(parent, lookup) !== workspaceId) fail('Items, lists and projects must belong to the same workspace. Clear those links before moving an item.');
    }
  }
  if (record.type === 'review' && !old) {
    for (const ref of record.included) {
      const target = await lookup(ref.type, ref.id);
      if (target && await workspaceOf(target, lookup) !== workspaceId) fail('A review can only include records in its workspace.');
    }
  }
}
