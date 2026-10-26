/** Remove administrative accounting while retaining a useful service-wait diagnosis. */
export function agentOperations<T>(value: T): T {
  const hidden = new Set([
    'budgets',
    'modelBudget',
    'usage',
    'maxTokens',
    'maxWallMinutes',
    'tokenLimit',
    'dailyTokens',
    'tokensUsed',
  ]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const row = v as Record<string, unknown>;
    const blocked =
      typeof row.code === 'string' &&
      /budget_exceeded|budget_exhausted|usage_unavailable|model_budget|worker_token_budget_exhausted/.test(
        row.code,
      );
    const out = Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !hidden.has(key))
        .map(([key, item]) => [key, walk(item)]),
    );
    if (
      row.modelBudget &&
      typeof row.modelBudget === 'object' &&
      (row.modelBudget as { blocked?: boolean }).blocked
    )
      out.serviceWait = { blocked: true, reason: 'worker_service_unavailable' };
    for (const key of ['closeReason', 'outcome', 'lastDecision'])
      if (
        typeof out[key] === 'string' &&
        /budget_exceeded|usage_unavailable|worker_token_budget_exhausted/.test(out[key] as string)
      )
        out[key] = 'service_unavailable';
    if (blocked) {
      for (const key of ['message', 'whose', 'related', 'cause', 'key']) delete out[key];
      Object.assign(out, {
        code: 'service_unavailable',
        why: 'The worker service is temporarily unavailable.',
        next: 'Keep the research state intact. Service recovery is handled outside the experiment.',
      });
    }
    return out;
  };
  return walk(value) as T;
}
