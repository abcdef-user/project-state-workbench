// Summaries are bounded independently of stored historical payload sizes.
export const SURFACE_BYTES = 48 * 1024;
export const COLLECTIONS = ['tasks', 'artifacts', 'operations', 'decisions', 'recentEvents'];
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

export function summarize(value, budget = 4096) {
  const copy = { ...value };
  const omittedFields = [];
  const identity = new Set(['projectId', 'taskId', 'operationId', 'decisionId', 'eventId', 'path']);
  for (const key of Object.keys(copy).sort((a, b) => bytes(copy[b]) - bytes(copy[a]))) {
    if (bytes(copy) <= budget) break;
    if (identity.has(key)) continue;
    omittedFields.push(key);
    delete copy[key];
  }
  // Legacy identifiers may themselves exceed the whole response budget.
  for (const key of identity) {
    if (typeof copy[key] === 'string' && copy[key].length > 512) {
      copy[key] = copy[key].slice(0, 512);
      omittedFields.push(key);
    }
  }
  if (omittedFields.length) copy.omittedFields = omittedFields;
  return copy;
}

export function boundSurface(surface, offsets, more) {
  if (surface.projectId.length > 512) {
    surface.projectId = surface.projectId.slice(0, 512);
    surface.omittedFields = ['projectId'];
  }
  for (const key of COLLECTIONS) surface[key] = surface[key].map((row) => summarize(row));
  surface.task = surface.task ? summarize(surface.task) : null;
  const updatePages = () => {
    surface.pagination = Object.fromEntries(COLLECTIONS.map((key) => [key, {
      hasMore: more[key], nextOffset: more[key] ? offsets[key] + surface[key].length : null,
    }]));
  };
  updatePages();
  while (bytes(surface) > SURFACE_BYTES - 1024) {
    const key = COLLECTIONS.filter((name) => surface[name].length)
      .sort((a, b) => bytes(surface[b]) - bytes(surface[a]))[0];
    if (!key) break;
    surface[key].pop();
    more[key] = true;
    updatePages();
  }
  surface.truncated = Boolean(surface.omittedFields || surface.task?.omittedFields)
    || COLLECTIONS.some((key) => more[key] || surface[key].some((row) => row.omittedFields));
  return surface;
}
