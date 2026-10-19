// Real browser touch helpers. Release points use the actual visible table.
exports.tablePoint = async page => page.locator('#play-table').evaluate(table => {
  const r = table.getBoundingClientRect();
  const top = Math.max(60, r.top + r.height * 0.22);
  const bottom = Math.min(innerHeight - 12, r.bottom - r.height * 0.23);
  if (bottom <= top) throw new Error('Table drop area is outside the visible viewport');
  return { x: r.left + r.width / 2, y: (top + bottom) / 2 };
});
exports.dragPoints = (start, end, steps = 6) => Array.from({ length: steps }, (_, i) => ({
  x: start.x + (end.x - start.x) * (i + 1) / steps,
  y: start.y + (end.y - start.y) * (i + 1) / steps,
}));
