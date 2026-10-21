/** Parent-only dedicated database provisioning through an existing local administrator socket.
 * Secret file is created durably BEFORE CREATE ROLE. Reruns use the same login/password.
 * No existing database ACLs, schemas, roles or memberships are changed.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { durable, need } from './history.mjs';
export async function provision(admin, secret) {
  need(
    secret.database === 'sandboxes_staging' && secret.role === 'sandboxes_staging',
    'fixed isolated database/login required',
  );
  need(/^[A-Za-z0-9_-]{43}$/.test(secret.password), 'invalid generated password');
  await admin.query("SELECT pg_advisory_lock(hashtext('merv-staging-provision'))");
  try {
    const old = (await admin.query("SELECT * FROM pg_roles WHERE rolname='sandboxes_staging'"))
      .rows[0];
    if (!old)
      await admin.query(
        `CREATE ROLE sandboxes_staging LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${secret.password}'`,
      );
    const role = (
      await admin.query(
        "SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='sandboxes_staging'",
      )
    ).rows[0];
    need(
      Object.values(role).every((v) => v === false),
      'existing staging role has excess authority',
    );
    need(
      (
        await admin.query(
          "SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='sandboxes_staging')",
        )
      ).rowCount === 0,
      'existing staging role has memberships',
    );
    const database = (
      await admin.query(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='sandboxes_staging'",
      )
    ).rows[0];
    if (!database) await admin.query('CREATE DATABASE sandboxes_staging OWNER sandboxes_staging');
    else need(database.owner === 'sandboxes_staging', 'existing database owner mismatch');
    await admin.query('REVOKE ALL ON DATABASE sandboxes_staging FROM PUBLIC');
    // Run on the existing Merv postgres DB: prove no pre-existing grants can leak through PUBLIC.
    const access = (
      await admin.query(
        "SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','v','m') AND n.nspname IN ('public','merv_ts_staging') AND has_table_privilege('sandboxes_staging',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')",
      )
    ).rows;
    need(
      access.length === 0,
      'PUBLIC grants expose existing tables; parent must isolate the login with reviewed pg_hba rules before use',
    );
    return { database: 'sandboxes_staging', role: 'sandboxes_staging', existingTableAccess: false };
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('merv-staging-provision'))");
  }
}
if (process.argv[1]?.endsWith('/provision.mjs')) {
  let db;
  try {
    need(process.getuid?.() === 0, 'root operator required');
    const file = process.argv[2];
    if (!existsSync(file))
      durable(file, {
        database: 'sandboxes_staging',
        role: 'sandboxes_staging',
        password: randomBytes(32).toString('base64url'),
        vaultKey: randomBytes(32).toString('base64url'),
      });
    need(
      lstatSync(file).isFile() &&
        !lstatSync(file).isSymbolicLink() &&
        !(lstatSync(file).mode & 0o077),
      'private regular secret file required',
    );
    db = new pg.Client({ connectionString: process.env.STAGING_POSTGRES_ADMIN_URL });
    await db.connect();
    durable(process.argv[3], await provision(db, JSON.parse(readFileSync(file))));
  } catch {
    console.error(
      'Provisioning refused; preserve private intent and inspect local database privileges.',
    );
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
