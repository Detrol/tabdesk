(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TabOrder = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function validIds(ids) {
    return Array.isArray(ids)
      && ids.every((id) => typeof id === 'string' && id)
      && new Set(ids).size === ids.length;
  }

  function move(ids, movingId, targetId, after) {
    if (!validIds(ids) || movingId === targetId
      || !ids.includes(movingId) || !ids.includes(targetId)) return null;
    const next = ids.filter((id) => id !== movingId);
    const target = next.indexOf(targetId);
    next.splice(target + (after ? 1 : 0), 0, movingId);
    return next.every((id, i) => id === ids[i]) ? null : next;
  }

  function reorderRecords(records, orderedIds) {
    if (!Array.isArray(records) || !validIds(orderedIds)) return null;
    const bySession = new Map(records.map((record) => [record && record.session, record]));
    if (orderedIds.some((id) => !bySession.has(id))) return null;
    let nextOrdered = 0;
    const ordered = new Set(orderedIds);
    return records.map((record) => ordered.has(record.session)
      ? bySession.get(orderedIds[nextOrdered++])
      : record);
  }

  function upsertRecord(records, record) {
    if (!Array.isArray(records) || !record || typeof record.session !== 'string' || !record.session) return null;
    const next = records.slice();
    const index = next.findIndex((item) => item && item.session === record.session);
    if (index < 0) next.push({ ...record });
    else next[index] = { ...next[index], ...record };
    return next;
  }

  return { move, reorderRecords, upsertRecord };
});
