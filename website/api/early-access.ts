// Early-access form → Attio: upsert the person by email, then add them to the list.
// Needs ATTIO_API_KEY and ATTIO_LIST (the list's api_slug) in the Vercel project.
const ATTIO = "https://api.attio.com/v2";
const field = (v: unknown) =>
  typeof v === "string" ? v.trim().slice(0, 300) : "";

export async function POST(req: Request) {
  const key = process.env.ATTIO_API_KEY;
  const list = process.env.ATTIO_LIST;
  if (!key || !list) return new Response("Not configured", { status: 500 });

  const body = await req.json().catch(() => ({}));
  const email = field(body.email);
  const values = {
    research_domain: field(body.domain),
    affiliation: field(body.affiliation),
    linkedin_x: field(body.handle),
  };
  if (!email.includes("@") || Object.values(values).some((v) => !v)) {
    return new Response("Bad request", { status: 400 });
  }

  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  const person = await fetch(
    `${ATTIO}/objects/people/records?matching_attribute=email_addresses`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ data: { values: { email_addresses: [email] } } }),
    },
  );
  if (!person.ok) return new Response("Upstream", { status: 502 });
  const { data } = await person.json();

  const entry = await fetch(`${ATTIO}/lists/${list}/entries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: {
        parent_record_id: data.id.record_id,
        parent_object: "people",
        entry_values: values,
      },
    }),
  });
  return new Response(null, { status: entry.ok ? 204 : 502 });
}
