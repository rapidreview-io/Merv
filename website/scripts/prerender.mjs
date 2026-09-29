import { build } from "esbuild";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
await mkdir(".prerender", { recursive: true });
try {
  await build({
    entryPoints: ["src/App.tsx"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: ".prerender/app.mjs",
    packages: "external",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "skip-font-css",
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, () => ({
            path: "empty",
            namespace: "empty",
          }));
          b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({
            contents: "",
            loader: "js",
          }));
        },
      },
    ],
  });
  const { default: App } = await import("../.prerender/app.mjs");
  const html = await readFile("dist/index.html", "utf8");
  await writeFile(
    "dist/index.html",
    html.replace(
      '<div id="root"></div>',
      `<div id="root">${renderToString(createElement(App))}</div>`,
    ),
  );
} finally {
  await rm(".prerender", { recursive: true, force: true });
}
