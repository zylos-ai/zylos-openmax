/**
 * Extract the authoritative Project snapshot that cws-core stores in message
 * metadata. The realtime frame is intentionally thin, so comm-bridge calls
 * get-message first and normally finds the snapshot at
 * message.metadata.project_context.
 */

export const PROJECT_CONTEXT_SCHEMA_VERSION = 1;

export function extractProjectContext(message) {
  const raw =
       message?.message?.metadata?.project_context
    ?? message?.metadata?.project_context
    ?? message?.content?.metadata?.project_context;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schema_version !== PROJECT_CONTEXT_SCHEMA_VERSION) return null;
  if (raw.selected_explicitly !== true) return null;

  const projectId = typeof raw.project_id === 'string' ? raw.project_id.trim() : '';
  if (!projectId) return null;

  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId,
    projectName: typeof raw.project_name_snapshot === 'string'
      ? raw.project_name_snapshot
      : '',
    selectedByMemberId: typeof raw.selected_by_member_id === 'string'
      ? raw.selected_by_member_id
      : '',
    validatedAt: typeof raw.validated_at === 'string' ? raw.validated_at : '',
  };
}
