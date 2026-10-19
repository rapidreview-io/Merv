/** Native shape containment after Excalidraw restores exact font dimensions. */
export function geometry(elements: any[]) {
  const live = elements.filter((e) => !e.isDeleted),
    failures: any[] = [];
  const body = live.filter((e) => !['frame', 'arrow'].includes(e.type) && !e.containerId);
  const inside = (shape: any, x: number, y: number) => {
    const nx = Math.abs(x - (shape.x + shape.width / 2)) / (shape.width / 2),
      ny = Math.abs(y - (shape.y + shape.height / 2)) / (shape.height / 2);
    return shape.type === 'diamond'
      ? nx + ny <= 1.01
      : shape.type === 'ellipse'
        ? nx * nx + ny * ny <= 1.01
        : nx <= 1.01 && ny <= 1.01;
  };
  for (const text of live.filter((e) => e.type === 'text' && e.containerId)) {
    const shape = live.find((e) => e.id === text.containerId);
    if (
      shape &&
      shape.type !== 'arrow' &&
      ![text.x, text.x + text.width].every((x) =>
        [text.y, text.y + text.height].every((y) => inside(shape, x, y)),
      )
    )
      failures.push({ kind: 'label-outside-shape', id: shape.id, text: text.originalText });
  }
  for (let i = 0; i < body.length; i++)
    for (let j = i + 1; j < body.length; j++) {
      const a = body[i],
        b = body[j];
      if (
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1
      )
        failures.push({ kind: 'body-overlap', ids: [a.id, b.id] });
    }
  for (const e of live.filter((e) => e.frameId)) {
    const f = live.find((f) => f.id === e.frameId);
    if (
      !f ||
      e.x < f.x - 1 ||
      e.y < f.y - 1 ||
      e.x + e.width > f.x + f.width + 1 ||
      e.y + e.height > f.y + f.height + 1
    )
      failures.push({ kind: 'outside-frame', id: e.id });
  }
  for (const arrow of live.filter((e) => e.type === 'arrow')) {
    for (const [binding, point] of [
      [arrow.startBinding, arrow.points?.[0]],
      [arrow.endBinding, arrow.points?.at(-1)],
    ]) {
      const shape = live.find((e) => e.id === binding?.elementId);
      if (!shape || !point) continue;
      const nx = Math.abs(arrow.x + point[0] - shape.x - shape.width / 2) / (shape.width / 2),
        ny = Math.abs(arrow.y + point[1] - shape.y - shape.height / 2) / (shape.height / 2);
      const boundary =
        shape.type === 'diamond'
          ? nx + ny
          : shape.type === 'ellipse'
            ? Math.hypot(nx, ny)
            : Math.max(nx, ny);
      if (Math.abs(boundary - 1) > 0.015)
        failures.push({ kind: 'arrow-off-boundary', id: arrow.id, shape: shape.id, boundary });
    }
  }
  for (const text of live.filter(
    (e) => e.type === 'text' && live.some((a) => a.type === 'arrow' && a.id === e.containerId),
  ))
    for (const shape of body) {
      if (
        Math.min(text.x + text.width, shape.x + shape.width) - Math.max(text.x, shape.x) > 1 &&
        Math.min(text.y + text.height, shape.y + shape.height) - Math.max(text.y, shape.y) > 1
      )
        failures.push({ kind: 'edge-label-overlap', id: text.id, shape: shape.id });
    }
  return failures;
}
