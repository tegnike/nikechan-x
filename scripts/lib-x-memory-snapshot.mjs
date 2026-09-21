/** Collect all pages before grouping so page boundaries never split threads. */
export async function fetchXMemorySnapshot(rpc, since, maxRows = 20000) {
 const rows = []; let after = '';
 while (true) {
  const page = await rpc('memory_x_source_snapshot_page_v1', {p_since:since,p_after:after,p_limit:500});
  if (!Array.isArray(page)) throw Error('invalid_x_snapshot_page');
  for (const row of page) {
   if (typeof row.source_key !== 'string' || row.source_key <= after) throw Error('x_snapshot_cursor_stalled');
   after = row.source_key; rows.push(row);
   if (rows.length > maxRows) throw Error('x_snapshot_limit_reached');
  }
  if (page.length < 500) return rows;
 }
}
