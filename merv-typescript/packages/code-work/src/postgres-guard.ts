/** Published Code guards share this exact PostgreSQL wrapper; whitespace is migration identity. */
export function postgresGuard(
  table: string,
  name: string,
  event: 'UPDATE' | 'DELETE',
  message: string,
  condition?: string,
): string {
  const raise = `RAISE EXCEPTION USING MESSAGE = '${message.replaceAll("'", "''")}', ERRCODE = '23514';`;
  return `CREATE OR REPLACE FUNCTION ${table}_${name}_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
${
  condition === undefined
    ? `  ${raise}`
    : `  IF ${condition} THEN
    ${raise}
  END IF;`
}
  RETURN ${event === 'DELETE' ? 'OLD' : 'NEW'};
END;
$merv$;
CREATE TRIGGER ${table}_${name} BEFORE ${event} ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${table}_${name}_guard();`;
}
