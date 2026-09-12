# Merv for Hermes Agent

This repository is generated from the canonical Merv skills. Do not edit it by
hand; it checks Merv's `main` branch every five minutes and replaces its
contents when the source changes.

```bash
hermes plugins install rapidreview-io/merv-hermes-client --enable
hermes mcp add merv --url https://experiments.rapidreview.io/mcp --auth oauth
```

Approve **All my projects** in the browser. When Merv announces an update, run:

```bash
hermes plugins update merv
```

Source: [rapidreview-io/Merv](https://github.com/rapidreview-io/Merv/tree/main/merv/clients/hermes)
