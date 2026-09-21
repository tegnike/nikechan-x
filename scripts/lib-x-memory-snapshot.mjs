/** Collect all pages before grouping so page boundaries never split threads. */
export async function fetchXMemorySnapshot(rpc, since, maxRows = 20000, options = {}) {
 const rows = []; let after = ''; let pageSize = 100;
 while (true) {
  if (options.shouldStop?.()) throw Error('x_snapshot_cancelled');
  const pageStarted=Date.now();
  let page;
  try { page = await rpc('memory_x_source_snapshot_page_v1', {p_since:since,p_after:after,p_limit:pageSize}); }
  catch (error) {
   if (String(error.message).includes('57014') && pageSize > 10) { pageSize = Math.max(10, Math.floor(pageSize / 2)); continue; }
   throw error;
  }
  if (!Array.isArray(page)) throw Error('invalid_x_snapshot_page');
  for (const row of page) {
   if (typeof row.source_key !== 'string' || row.source_key <= after) throw Error('x_snapshot_cursor_stalled');
   after = row.source_key; rows.push(row);
   if (rows.length > maxRows) throw Error('x_snapshot_limit_reached');
  }
  options.onPage?.({rows:rows.length,after,pageSize,ms:Date.now()-pageStarted});
  if (page.length < pageSize) return rows;
 }
}
