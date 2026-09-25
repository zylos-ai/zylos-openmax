// Preserve the form's REST fields without forwarding DM envelope metadata.
export function automationConfiguration(params, sourceKind) {
  const input = params.configuration ?? params;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('configuration must be an object'), { status: 400 });
  }
  const spec = input.spec ?? {
    project_id: input.projectId,
    title: input.title,
    description: input.description,
  };
  const body = {
    lead_member_id: input.lead_member_id ?? input.leadMemberId,
    owner_member_id: input.owner_member_id ?? input.ownerMemberId,
    spec: { project_id: spec.project_id, title: spec.title, description: spec.description },
  };
  const fields = sourceKind === 'webhook'
    ? [['event_filter', 'eventFilter']]
    : [['schedule_kind', 'scheduleKind'], ['cron_expr', 'cronExpr'],
      ['timezone', 'timezone'], ['run_at', 'runAt'],
      ['interval_seconds', 'intervalSeconds'], ['anchor_at', 'anchorAt']];
  for (const [wire, alias] of fields) {
    const value = input[wire] ?? input[alias];
    if (value !== undefined) body[wire] = value;
  }
  return body;
}
