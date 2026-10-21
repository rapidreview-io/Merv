// Early-access form → Attio: upsert the person by email, then add them to the list.
// Needs ATTIO_API_KEY and ATTIO_LIST (the list's api_slug) in the Vercel project;
// RESEND_API_KEY sends the confirmation (skipped, and logged, when unset or failing).
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
  if (!person.ok) return upstream("person", person);
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
  if (!entry.ok) return upstream("entry", entry);
  await confirm(email);
  return new Response(null, { status: 204 });
}
async function confirm(email: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return console.error("resend: no key, confirmation not sent");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "Merv <support@rapidreview.io>",
      to: [email],
      subject: "You’re on the Merv early access list",
      text: "Thank you for signing up for early access to Merv. We will reach out as more spots open.\n\n— rapidreview team\nhttps://rapidreview.io · https://runmerv.com",
      html: '<p>Thank you for signing up for early access to Merv. We will reach out as more spots open.</p><p>— rapidreview team<br><a href="https://rapidreview.io">rapidreview.io</a> · <a href="https://runmerv.com">runmerv.com</a></p>',
    }),
  });
  if (!res.ok)
    console.error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
async function upstream(step: string, res: Response) {
  console.error(
    `attio ${step} ${res.status}: ${(await res.text()).slice(0, 500)}`,
  );
  return new Response("Upstream", { status: 502 });
}
