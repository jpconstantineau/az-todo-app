// Shared lists use their own transaction boundary; private v1 records stay private.
import { createHash } from 'node:crypto';
import { app } from './shared/http.mjs';
import { getClientPrincipal } from './shared/auth.mjs';
import { container } from './shared/db.mjs';
import { ValidationError } from './shared/validate.mjs';
import { identifier, object, digest, bytes } from './v1/contract.mjs';
import { ApiError } from './v1/store.mjs';

const permissions = ['view', 'add', 'edit', 'complete', 'delete'];
const partition = id => [`shared:${id}`, 'shared-list', 'v1'];
const hash = token => createHash('sha256').update(token).digest('hex');
const fail = message => { throw new ValidationError(message); };
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Enter 1–${max} characters.`);
  return value;
};
function grant(value) {
  if (!Array.isArray(value) || !value.includes('view') || value.some(p => !permissions.includes(p)) || new Set(value).size !== value.length) fail('Permissions must include view and only view, add, edit, complete or delete.');
  return value;
}
async function read(id, key = 'list') {
  try { return (await container.item(key, partition(id)).read()).resource ?? null; }
  catch (error) { if (error.code === 404) return null; throw error; }
}
function allowed(list, user) {
  return list.ownerId === user ? permissions : list.members.find(m => m.accountId === user)?.permissions || [];
}
function access(list, user, permission = 'view') {
  if (!list || !allowed(list, user).includes(permission) || list.deleted && list.ownerId !== user) throw new ApiError(403, 'shared_access_denied', 'This shared list is unavailable or your permission was removed. Pending text is kept for recovery.');
}
function snapshot(list, user) {
  access(list, user);
  return { id: list.listId, title: list.title, revision: list.revision, deleted: list.deleted,
    owner: list.ownerId === user, permissions: allowed(list, user), items: list.deleted ? [] : list.items,
    ...(list.ownerId === user ? { members: list.members, invitations: list.invitations.map(({ id, permissions, expiresAt }) => ({ id, permissions, expiresAt })) } : {}) };
}
function operation(raw) {
  object(raw, ['accountId', 'listId', 'operationId', 'expectedRevision', 'action', 'fields'], 'operation');
  identifier(raw.listId); identifier(raw.operationId);
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) fail('expectedRevision must be a non-negative integer.');
  const keys = { create: ['title'], rename: ['title'], add: ['id', 'title'], edit: ['id', 'title'], complete: ['id', 'completed'], delete: ['id'], restoreItem: ['id'], invite: ['id', 'token', 'permissions'], cancelInvite: ['id'], join: ['token'], permissions: ['accountId', 'permissions'], revoke: ['accountId'], deleteList: [], restoreList: [] };
  if (!Object.hasOwn(keys, raw.action)) fail('Unsupported shared-list action.');
  object(raw.fields, keys[raw.action], 'fields');
  if (keys[raw.action].some(key => !(key in raw.fields))) fail('Missing required field.');
  const f = raw.fields;
  if ('id' in f) identifier(f.id);
  if ('title' in f) text(f.title, 200);
  if ('accountId' in f) text(f.accountId, 200);
  if ('completed' in f && typeof f.completed !== 'boolean') fail('completed must be true or false.');
  if ('permissions' in f) grant(f.permissions);
  if ('token' in f && (typeof f.token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(f.token))) fail('Invalid invitation code.');
  return raw;
}

async function commit(op, principal) {
  const user = principal.userId, requestHash = digest(op), receiptId = `receipt:${hash(user)}:${op.operationId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await read(op.listId);
    const owner = old?.ownerId === user;
    const joining = op.action === 'join';
    if (op.action === 'create') {
      if (old && !owner) throw new ApiError(403, 'shared_access_denied', 'This list ID is unavailable.');
    } else if (joining) {
      if (!old || old.deleted) throw new ApiError(403, 'invalid_invitation', 'Invitation is unavailable, expired or already used.');
    } else access(old, user);
    // Check current authorization before replay, so revoked users cannot read receipts.
    const previous = old && await read(op.listId, receiptId);
    if (previous && (!joining || allowed(old, user).includes('view'))) {
      if (previous.requestHash !== requestHash) throw new ApiError(409, 'operation_reused', 'Use a new operation ID for different content.');
      return previous.response;
    }
    const ownerActions = ['rename', 'invite', 'cancelInvite', 'permissions', 'revoke', 'deleteList', 'restoreList'];
    if (ownerActions.includes(op.action) && !owner) throw new ApiError(403, 'owner_required', 'Only the list owner can change sharing or list settings.');
    if (old?.deleted && op.action !== 'restoreList') throw new ApiError(409, 'list_deleted', 'The owner must restore this list before it can be changed.');
    const required = { add: 'add', edit: 'edit', complete: 'complete', delete: 'delete', restoreItem: 'delete' }[op.action];
    if (required) access(old, user, required);
    // Invitations authorize joining a current list, not overwriting its content.
    if (!joining && (old?.revision ?? 0) !== op.expectedRevision) throw new ApiError(409, 'shared_conflict', 'This list changed. Refresh and review the current list before retrying your saved action.');
    const next = old ? structuredClone(old) : { id: 'list', UserID: partition(op.listId)[0], ObjectType: 'shared-list', ObjectID: 'v1', ttl: -1,
      kind: 'shared-list', listId: op.listId, ownerId: user, title: op.fields.title, revision: 0, deleted: false, items: [], members: [], invitations: [] };
    const f = op.fields, now = new Date().toISOString();
    if (op.action === 'create' && old) fail('List already exists.');
    if (op.action === 'rename') next.title = f.title;
    if (op.action === 'add') {
      // ponytail: one bounded document keeps list edits, grants and receipts atomic.
      if (next.items.length >= 200) fail('A shared list supports 200 items, including deleted items. Create another list when full.');
      if (next.items.some(item => item.id === f.id)) fail('Item ID already exists.');
      next.items.push({ id: f.id, title: f.title, completed: false, deleted: false });
    }
    if (['edit', 'complete', 'delete', 'restoreItem'].includes(op.action)) {
      const item = next.items.find(item => item.id === f.id);
      if (!item || item.deleted !== (op.action === 'restoreItem')) throw new ApiError(409, 'item_unavailable', 'This item changed or was deleted. Refresh before trying again.');
      if (op.action === 'edit') item.title = f.title;
      if (op.action === 'complete') item.completed = f.completed;
      if (op.action === 'delete' || op.action === 'restoreItem') item.deleted = op.action === 'delete';
    }
    if (op.action === 'invite') {
      next.invitations = next.invitations.filter(i => i.expiresAt > now);
      if (next.invitations.length >= 20 || next.members.length >= 20) fail('A shared list supports 20 members and 20 open invitations.');
      if (next.invitations.some(i => i.id === f.id || i.tokenHash === hash(f.token))) fail('Invitation already exists.');
      next.invitations.push({ id: f.id, tokenHash: hash(f.token), permissions: f.permissions, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    }
    if (joining) {
      const invite = next.invitations.find(i => i.tokenHash === hash(f.token) && i.expiresAt > now);
      if (!invite || owner || next.members.some(m => m.accountId === user)) throw new ApiError(403, 'invalid_invitation', 'Invitation is unavailable, expired or already used.');
      if (next.members.length >= 20) fail('This shared list already has 20 members.');
      next.members.push({ accountId: user, name: typeof principal.userDetails === 'string' ? principal.userDetails.slice(0, 200) : 'Member', permissions: invite.permissions });
      next.invitations = next.invitations.filter(i => i.id !== invite.id);
    }
    if (op.action === 'cancelInvite') next.invitations = next.invitations.filter(i => i.id !== f.id);
    if (op.action === 'permissions' || op.action === 'revoke') {
      const member = next.members.find(m => m.accountId === f.accountId);
      if (!member) fail('Member is no longer on this list.');
      if (op.action === 'permissions') member.permissions = f.permissions;
      else next.members = next.members.filter(m => m.accountId !== f.accountId);
    }
    if (op.action === 'deleteList' || op.action === 'restoreList') {
      next.deleted = op.action === 'deleteList';
      if (next.deleted) { next.members = []; next.invitations = []; }
    }
    next.revision++; next.updatedUtc = now;
    if (bytes(next) > 200000) fail('This shared list is full. Create another list.');
    const response = { apiVersion: 1, accountId: user, listId: op.listId, operationId: op.operationId, revision: next.revision };
    const receipt = { id: receiptId, UserID: next.UserID, ObjectType: next.ObjectType, ObjectID: next.ObjectID, ttl: -1, kind: 'shared-receipt', requestHash, response };
    const result = await container.items.batch([
      old ? { operationType: 'Replace', id: 'list', resourceBody: next, ifMatch: old._etag } : { operationType: 'Create', resourceBody: next },
      { operationType: 'Create', resourceBody: receipt }
    ], partition(op.listId));
    const codes = [result.code, ...(result.result || []).map(r => r.statusCode)];
    if (codes.some(code => [409, 412].includes(code))) continue;
    if (result.code < 200 || result.code >= 300 || result.result?.length !== 2 || result.result.some(r => r.statusCode < 200 || r.statusCode >= 300)) throw new ApiError(503, 'storage_unavailable', 'Save was not acknowledged. Retry the same action unchanged.');
    return response;
  }
  throw new ApiError(503, 'shared_busy', 'The list is busy. Retry the same action unchanged.');
}

function route(name, method, handler) {
  app.http(`shared-${name}`, { route: `shared/${name}`, methods: [method], authLevel: 'anonymous', handler: async req => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    try {
      if (process.env.V1_API_ENABLED !== 'true') throw new ApiError(503, 'v1_disabled', 'Shared lists are unavailable.');
      const principal = getClientPrincipal(req.headers);
      if (!principal) throw new ApiError(401, 'sign_in_required', 'Sign in to use shared lists.');
      return json({ apiVersion: 1, accountId: principal.userId, ...await handler(req, principal) });
    } catch (error) {
      return json({ apiVersion: 1, error: error instanceof ValidationError ? 'invalid_request' : error.code || 'storage_unavailable',
        message: error instanceof ValidationError || error instanceof ApiError ? error.message : 'Request was not acknowledged. Keep your pending action and retry unchanged.' }, error instanceof ValidationError ? 400 : error.status || 503);
    }
  } });
}
route('lists', 'GET', async (req, principal) => {
  const cursor = req.query.get('cursor') || undefined;
  if (cursor && cursor.length > 16000) fail('Invalid page cursor.');
  const page = await container.items.query({
    query: "SELECT * FROM c WHERE c.kind='shared-list' AND (c.ownerId=@u OR (c.deleted=false AND ARRAY_CONTAINS(c.members, {\"accountId\": @u}, true)))",
    parameters: [{ name: '@u', value: principal.userId }]
  }, { maxItemCount: 50, continuationToken: cursor }).fetchNext();
  return { lists: page.resources.map(list => ({ id: list.listId, title: list.title, deleted: list.deleted, owner: list.ownerId === principal.userId })), cursor: page.continuationToken || null };
});
route('list', 'GET', async (req, principal) => ({ list: snapshot(await read(identifier(req.query.get('id'))), principal.userId) }));
route('operations', 'POST', async (req, principal) => {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required', 'Send application/json.');
  const reader = req.body?.getReader();
  if (!reader) fail('A JSON action is required.');
  const chunks = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > 8192) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Shared actions must be at most 8 KiB.'); }
    chunks.push(part.value);
  }
  let raw;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('Submit valid UTF-8 JSON.'); }
  const op = operation(raw);
  if (op.accountId !== principal.userId) throw new ApiError(409, 'account_mismatch', 'Sign back into the account that saved this action.');
  return commit(op, principal);
});
