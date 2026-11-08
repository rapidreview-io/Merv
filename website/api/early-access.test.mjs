import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";

const source = await readFile(
  new URL("./early-access.ts", import.meta.url),
  "utf8",
);
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { POST } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("optional confirmation failures preserve signup success; CRM failures do not", async (t) => {
  for (const name of ["ATTIO_API_KEY", "ATTIO_LIST", "RESEND_API_KEY"]) {
    const previous = process.env[name];
    process.env[name] = "fixture";
    t.after(() =>
      previous === undefined
        ? delete process.env[name]
        : (process.env[name] = previous),
    );
  }
  t.mock.method(console, "error", () => {});
  for (const failure of ["network", "response", "body", "person", "entry"]) {
    const writes = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url.includes("resend.com")) {
        if (failure === "network") throw new Error("disconnected");
        return {
          ok: false,
          status: 503,
          text: async () => {
            if (failure === "body") throw new Error("body disconnected");
            return "unavailable";
          },
        };
      }
      const step = url.includes("/objects/") ? "person" : "entry";
      if (failure === step) return new Response("unavailable", { status: 503 });
      writes.push(step);
      return Response.json({ data: { id: { record_id: "person" } } });
    });
    const response = await POST(
      new Request("https://example.test/api/early-access", {
        method: "POST",
        body: JSON.stringify({
          email: "person@example.test",
          domain: "ML",
          affiliation: "Lab",
          handle: "person",
        }),
      }),
    );
    assert.equal(
      response.status,
      ["person", "entry"].includes(failure) ? 502 : 204,
    );
    assert.deepEqual(
      writes,
      failure === "person"
        ? []
        : failure === "entry"
          ? ["person"]
          : ["person", "entry"],
    );
    t.mock.restoreAll();
    t.mock.method(console, "error", () => {});
  }
});
