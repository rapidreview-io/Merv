#!/usr/bin/env python3
"""Deterministic arithmetic fixture, not evidence about an external population."""
import hashlib
import json
import random

rng = random.Random(1729)
sample = [rng.randrange(-20, 41) for _ in range(64)]
n = len(sample)
s = sum(sample)
# Integer numerators avoid platform-dependent floating point comparisons.
zero_sse_n2 = sum(x*x for x in sample)*n*n
mean_sse_n2 = sum((x*n-s)**2 for x in sample)
result = {
    'seed':1729, 'n':n, 'sum':s,
    'sample_sha256':hashlib.sha256(json.dumps(sample,separators=(',',':')).encode()).hexdigest(),
    'mean':s/n, 'zero_mse':zero_sse_n2/(n**3), 'mean_mse':mean_sse_n2/(n**3),
    'difference_numerator':zero_sse_n2-mean_sse_n2, 'denominator':n**3,
    'mean_no_worse_on_sample':mean_sse_n2<=zero_sse_n2,
    'limitation':'Same-sample algebraic check. No held-out performance or population inference.',
}
print(json.dumps(result,sort_keys=True))
