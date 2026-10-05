import { memberships, normalizeMembership } from './collection-model.js?v=66';
// Branching clarification keeps task changes pending until the final confirmation.
export const flowProposal = () => ({ text: '', choice: '', projectId: '', projectTitle: '', outcome: '', waitingOn: '', reviewDate: '', startDate: '', plannedDay: '', listId: '', notes: '' });
export const newFlow = () => ({ flowVersion: 2, step: 'actionable', answers: {}, proposal: flowProposal() });
export function flowPath(answers) {
  return ['actionable', ...(answers.actionable === 'yes' ? ['nextAction', 'project', 'twoMinutes'] : []), 'disposition', ...(answers.disposition?.choice === 'trash' ? [] : ['organize']), 'summary', 'complete'];
}
function required(text, max, label) {
  if (!text?.trim() || text.length > max) throw new Error(`${label} needs 1–${max} characters.`);
  return text;
}
export function flowAnswer(step, p, answers) {
  if (['actionable', 'twoMinutes'].includes(step)) {
    if (!['yes', 'no'].includes(p.choice)) throw new Error('Choose Yes or No.');
    return p.choice;
  }
  if (step === 'nextAction') return required(p.text, 200, 'Next action');
  if (step === 'project') {
    if (!['keep', 'none', 'existing', 'new'].includes(p.choice)) throw new Error('Choose an existing project, create one, or choose a standalone action.');
    if (p.choice === 'existing' && !p.projectId) throw new Error('Choose a project.');
    if (p.choice === 'new') { required(p.projectTitle, 200, 'Project title'); required(p.outcome, 4000, 'Desired outcome'); }
    return { choice: p.choice, projectId: p.choice === 'existing' ? p.projectId : '', projectTitle: p.choice === 'new' ? p.projectTitle : '', outcome: p.choice === 'new' ? p.outcome : '' };
  }
  if (step === 'disposition') {
    const allowed = answers.actionable === 'no' ? ['someday', 'reference', 'trash'] : ['next', 'waiting', 'planned', 'deferred', 'dropped', ...(answers.twoMinutes === 'yes' ? ['completed'] : [])];
    if (!allowed.includes(p.choice)) throw new Error('Choose what should happen next.');
    if (p.choice === 'waiting') required(p.waitingOn, 4000, 'Waiting for');
    if (p.choice === 'planned' && !p.plannedDay) throw new Error('Choose a planned day.');
    if (p.choice === 'deferred' && !p.startDate) throw new Error('Choose a start date.');
    return { choice: p.choice, waitingOn: p.choice === 'waiting' ? p.waitingOn : '', reviewDate: ['waiting', 'someday'].includes(p.choice) ? p.reviewDate : '', startDate: p.choice === 'deferred' ? p.startDate : '', plannedDay: p.choice === 'planned' ? p.plannedDay : '' };
  }
  if (step === 'organize') return { text: required(p.text, 200, 'Working title'), listId: p.listId, notes: p.notes, ...(p.collectionRefs ? { collectionRefs: p.collectionRefs, projectId: p.projectId } : {}) };
  throw new Error('This step cannot accept an answer.');
}
export function flowDecision(session, proposal, choice, item) {
  const path = flowPath(session.answers), index = path.indexOf(session.step);
  if (choice === 'back') {
    if (index < 1 || session.step === 'complete') throw new Error('There is no previous question.');
    const step = path[index - 1], value = session.answers[step], answers = { ...session.answers };
    delete answers[step];
    return { ...session, step, answers, proposal: { ...flowProposal(), ...(typeof value === 'string' ? { [step === 'nextAction' ? 'text' : 'choice']: value } : value) } };
  }
  const answers = { ...session.answers, [session.step]: flowAnswer(session.step, proposal, session.answers) };
  const nextPath = flowPath(answers), step = nextPath[nextPath.indexOf(session.step) + 1];
  const next = flowProposal();
  if (step === 'project') next.choice = item.projectId ? 'keep' : '';
  if (step === 'organize') {
    const group = answers.project, patch = group?.choice === 'existing' ? { projectId: group.projectId } : ['none', 'new'].includes(group?.choice) ? { projectId: null } : {};
    const organized = normalizeMembership({ ...item, ...patch }, item, patch);
    Object.assign(next, { text: answers.nextAction || item.title, listId: organized.listId || '', projectId: organized.projectId || '', collectionRefs: memberships(organized) });
  }
  return { flowVersion: 2, step, answers, proposal: next };
}
export function flowEdits(answers) {
  const d = answers.disposition, group = answers.project, organization = answers.organize;
  const fields = { title: organization.text, listId: organization.listId || null, status: d.choice === 'planned' ? 'next' : d.choice };
  if (organization.collectionRefs) Object.assign(fields, { collectionRefs: organization.collectionRefs, projectId: organization.projectId || null });
  if (!organization.collectionRefs && group?.choice === 'none') fields.projectId = null;
  if (!organization.collectionRefs && group?.choice === 'existing') fields.projectId = group.projectId;
  if (d.choice === 'waiting') Object.assign(fields, { waitingOn: d.waitingOn, ...(d.reviewDate ? { reviewDate: d.reviewDate, reviewDateUtc: null } : {}) });
  if (d.choice === 'someday') Object.assign(fields, { reviewDate: d.reviewDate || null, reviewDateUtc: null });
  if (d.choice === 'deferred') Object.assign(fields, { startDate: d.startDate, startDateUtc: null });
  if (d.choice === 'planned') fields.plannedDay = d.plannedDay;
  return fields;
}
