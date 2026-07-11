const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const WORK_REFERENCE_RE = new RegExp(
  `\\[([^\\]]+)\\]\\(((proj|issue):\\/\\/(${UUID_PATTERN}))\\)|\\b((proj|issue):\\/\\/(${UUID_PATTERN}))(?![\\w-])`,
  'g',
);

export const MAX_WORK_REFERENCES = 10;

function escapeXmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function extractWorkReferences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const references = [];
  const seen = new Set();
  WORK_REFERENCE_RE.lastIndex = 0;
  let match = WORK_REFERENCE_RE.exec(text);
  while (match) {
    const uri = match[2] || match[5];
    const kind = match[3] || match[6];
    const id = match[4] || match[7];
    if (!seen.has(uri)) {
      seen.add(uri);
      references.push({
        kind: kind === 'proj' ? 'project' : 'issue',
        id,
        uri,
        label: match[1]?.replace(/^#/, '') || '',
      });
      if (references.length === MAX_WORK_REFERENCES) break;
    }
    match = WORK_REFERENCE_RE.exec(text);
  }
  return references;
}

export function formatWorkReferenceContext(references) {
  if (!Array.isArray(references) || references.length === 0) return '';
  const items = references.slice(0, MAX_WORK_REFERENCES).map((reference) => {
    const tag = reference.kind === 'project' ? 'project' : 'issue';
    const label = reference.label
      ? ` label="${escapeXmlAttribute(reference.label)}"`
      : '';
    return `  <${tag} id="${escapeXmlAttribute(reference.id)}" uri="${escapeXmlAttribute(reference.uri)}"${label} />`;
  });
  return [
    '<work-references>',
    'These are existing work objects referenced by the human. A reference establishes context only; it does not start work or grant access.',
    ...items,
    '</work-references>',
  ].join('\n');
}
