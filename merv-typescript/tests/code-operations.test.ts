import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller, CodeStoreOperation } from '@merv/contracts';
import type { CodeImportRemote, FaultPoint } from '@merv/code/store/operations';
import {
  backends,
  codeStoreFixture,
  faultAt,
  git,
  gitSource,
  optional,
} from './fixtures/code-store.js';

const complete = async (f: Awaited<ReturnType<typeof codeStoreFixture>>, id: string) =>
  (
    (await f.code.v2!.call(f.admin, `uploads/${id}/complete`, {})) as {
      operation: CodeStoreOperation;
    }
  ).operation;
const secret = `gh${'p'}_${'A1b2'.repeat(9)}`;

for (const backend of backends) {
  test(
    `${backend}: a repository is imported in parts, continued by a thin bundle, and every call replays`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const one = source.commit({
        'README.md': 'one\n',
        'data.txt': Array.from({ length: 3000 }, (_, index) => `row ${index}`).join('\n'),
      });
      const f = await codeStoreFixture(t, backend, {}, one);
      const before = await f.code.status(f.admin);
      assert.equal(before.project!.durability, 'legacy-local');
      assert.equal(before.project!.main.stored, false);
      assert.equal(before.store!.hosted, false);

      const first = source.bundle(one);
      const input = {
        source: 'bundle' as const,
        tip: one,
        bundle: { sha256: first.sha256, bytes: first.bytes },
        requestId: 'first',
      };
      const begun = await f.code.importRepository(f.admin, input);
      assert.deepEqual(
        [begun.kind, begun.status, begun.phase, begun.received, begun.bytes, begun.head],
        ['import', 'prepared', 'receiving', 0, first.bytes, one],
      );
      assert.deepEqual(await f.code.importRepository(f.admin, input), begun);
      await assert.rejects(f.code.importRepository(f.admin, { ...input, tip: 'b'.repeat(40) }), {
        code: 'request_conflict',
      });
      // Completing before the bytes arrived is refused and says how far they got.
      await assert.rejects(complete(f, begun.id), { code: 'code_upload_incomplete' });

      const half = Math.floor(first.bytes / 2);
      const put = (offset: number, end: number) =>
        f.code.v2!.putPart(f.admin, begun.id, offset, first.content.subarray(offset, end));
      assert.deepEqual(await put(0, half), { received: half });
      // The same part again is a replay; one that starts elsewhere is refused.
      assert.deepEqual(await put(0, half), { received: half });
      await assert.rejects(put(half + 1, first.bytes), { code: 'code_upload_offset', status: 409 });
      await assert.rejects(put(0, first.bytes), { code: 'code_upload_offset' });
      assert.equal(
        (
          (await f.code.v2!.call(f.admin, `uploads/${begun.id}`, {})) as {
            operation: CodeStoreOperation;
          }
        ).operation.received,
        half,
      );
      await assert.rejects(
        f.code.v2!.putPart(
          f.admin,
          begun.id,
          half,
          Buffer.concat([first.content.subarray(half), Buffer.from('x')]),
        ),
        { code: 'code_upload_too_large', status: 413 },
      );
      assert.deepEqual(await put(half, first.bytes), { received: first.bytes });

      const done = await complete(f, begun.id);
      assert.deepEqual(
        [done.status, done.phase, done.error, done.findings],
        ['completed', 'refs_applied', null, []],
      );
      assert.deepEqual(await complete(f, begun.id), done);
      assert.deepEqual(await f.code.importRepository(f.admin, input), done);
      await assert.rejects(put(0, half), { code: 'code_upload_closed' });
      assert.deepEqual(f.refs(), [`refs/merv/imports/${begun.id} ${one}`]);
      assert.equal(existsSync(join(f.paths.quarantine, begun.id)), false);

      const hosted = await f.code.status(f.admin);
      assert.equal(hosted.project!.durability, 'code');
      // Main was already named; the import found it in what it admitted.
      assert.equal(hosted.project!.main.stored, true);
      assert.deepEqual(
        [
          hosted.store!.hosted,
          hosted.store!.objectFormat,
          hosted.store!.rootOid,
          hosted.store!.source,
          hosted.store!.tips,
        ],
        [true, 'sha1', one, 'bundle', [one]],
      );
      assert.ok(hosted.store!.diskBytes > 0);
      assert.deepEqual(hosted.operations, []);
      assert.deepEqual(
        (await f.state.events(f.admin.projectId))
          .filter((event) => event.type.startsWith('code.'))
          .map((event) => [event.type, event.data.head]),
        [['code.repository_imported', one]],
      );

      // A later import builds on what is kept and sends only what is new.
      const two = source.commit({ 'README.md': 'two\n' });
      const thin = source.bundle(two, [one]);
      assert.ok(thin.bytes < first.bytes / 2);
      const continued = await f.deliver(thin);
      assert.equal(continued.status, 'completed');
      const status = await f.code.status(f.admin);
      assert.deepEqual(status.store!.tips.sort(), [one, two].sort());
      assert.equal(status.store!.rootOid, one);
      assert.equal(git(f.paths.repository, ['cat-file', '-t', two]), 'commit');
      git(f.paths.repository, ['fsck', '--strict', '--no-dangling']);
    },
  );

  test(
    `${backend}: only the administrator who began an import continues it, and a worker never does`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
      const f = await codeStoreFixture(t, backend, { receiving: 1 });
      const input = {
        source: 'bundle' as const,
        tip: bundle.tip,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId: 'one',
      };
      const issue = async (role: 'operator' | 'producer') => {
        const issued = await f.scope.issueActor(f.admin, { name: role, role });
        return {
          projectId: f.admin.projectId,
          actorId: issued.actor.id,
          credentialId: issued.credential.id,
        } satisfies Caller;
      };
      const producer = await issue('producer');
      await assert.rejects(f.code.importRepository(producer, input), { status: 403 });
      await assert.rejects(
        f.code.importRepository({ ...f.admin, session: { id: 's' } } as Caller, input),
        (error: { status: number }) => error.status === 403,
      );
      await assert.rejects(
        f.code.configureRepository(producer, {
          denyGlobs: [],
          secretExemptGlobs: [],
          requestId: 'c',
        }),
        { status: 403 },
      );
      const begun = await f.code.importRepository(f.admin, input);
      const other = await issue('operator');
      await assert.rejects(f.code.v2!.putPart(other, begun.id, 0, bundle.content), {
        code: 'code_operation_forbidden',
      });
      await assert.rejects(f.code.v2!.putPart(producer, begun.id, 0, bundle.content), {
        status: 403,
      });
      await assert.rejects(f.code.v2!.call(other, `uploads/${begun.id}/complete`, {}), {
        code: 'code_operation_forbidden',
      });
      await assert.rejects(f.code.v2!.call(f.admin, 'uploads/cop_missing/complete', {}), {
        code: 'code_operation_not_found',
      });
      await assert.rejects(f.code.v2!.call(f.admin, 'anything/else', {}), { code: 'not_found' });
      // One project holds only so many unfinished transfers.
      await assert.rejects(f.code.importRepository(other, { ...input, requestId: 'two' }), {
        code: 'code_store_unavailable',
        status: 503,
      });

      // A project that names no repository has nothing to import into.
      const elsewhere = await f.scope.bootstrap({ projectName: 'Unbound', actorName: 'Owner' });
      await assert.rejects(
        f.code.importRepository(
          {
            projectId: elsewhere.project.id,
            actorId: elsewhere.actor.id,
            credentialId: elsewhere.credential.id,
          },
          input,
        ),
        { code: 'code_project_unbound', status: 409 },
      );

      // A transfer nobody continues is given up by the next sweep, and its bytes go with it.
      await f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content.subarray(0, 10));
      await f.open();
      assert.equal((await f.operationRow(begun.id))!.status, 'prepared');
      const swept = await codeStoreFixture(t, backend, { abandonSeconds: 0 });
      const stale = await swept.code.importRepository(swept.admin, input);
      await swept.code.v2!.putPart(swept.admin, stale.id, 0, bundle.content.subarray(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await swept.open();
      assert.deepEqual(await swept.operationRow(stale.id), {
        status: 'failed',
        phase: 'receiving',
        error: 'code_upload_abandoned',
      });
      assert.equal(existsSync(join(swept.paths.quarantine, stale.id)), false);
    },
  );

  test(
    `${backend}: ending the process at every boundary leaves one receipt, one completed row and no quarantine`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const tip = source.commit({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
      const bundle = source.bundle(tip);
      const points: FaultPoint[] = [
        'after_part',
        'after_index',
        'after_admitting',
        'after_migrate',
        'after_objects_durable',
        'after_ref',
        'after_refs_applied',
        'before_ack',
      ];
      const phases: Record<string, string> = {};
      for (const point of points) {
        const f = await codeStoreFixture(t, backend, {}, tip);
        await f.open({ fault: faultAt(point) });
        await assert.rejects(
          f.deliver(bundle, 64, 'crashed'),
          new RegExp(`process ended ${point}`),
          point,
        );
        const [{ id }] = (await f.code.status(f.admin)).operations.length
          ? (await f.code.status(f.admin)).operations
          : [{ id: '' }];
        const interrupted = id ? await f.operationRow(id) : undefined;
        phases[point] = interrupted ? `${interrupted.status}/${interrupted.phase}` : 'completed';

        // A new process on the same directory and database finishes what was journalled…
        await f.open();
        // …and the sender, who never heard back, simply asks again.
        const again = await f.deliver(bundle, 64, 'crashed');
        assert.deepEqual(
          [again.status, again.phase, again.head],
          ['completed', 'refs_applied', tip],
          point,
        );
        assert.deepEqual(f.refs(), [`refs/merv/imports/${again.id} ${tip}`], point);
        const rows = await f.state.read(
          async (sql) =>
            await sql.all<{ status: string }>(
              "SELECT status FROM code_operations WHERE kind='import'",
            ),
        );
        assert.deepEqual(
          rows.map((row) => row.status),
          ['completed'],
          point,
        );
        await f.open();
        assert.deepEqual(
          existsSync(f.paths.quarantine) ? readdirSync(f.paths.quarantine) : [],
          [],
          point,
        );
        const status = await f.code.status(f.admin);
        assert.deepEqual(
          [status.store!.hosted, status.project!.main.stored, status.operations],
          [true, true, []],
          point,
        );
        git(f.paths.repository, ['fsck', '--strict', '--no-dangling']);
        assert.equal(
          readdirSync(join(f.paths.repository, 'objects', 'pack')).filter((name) =>
            name.endsWith('.pack'),
          ).length,
          1,
          point,
        );
      }
      // The journal stood where each boundary says it stands.
      assert.deepEqual(phases, {
        after_part: 'prepared/receiving',
        after_index: 'prepared/receiving',
        after_admitting: 'prepared/admitting',
        after_migrate: 'prepared/admitting',
        after_objects_durable: 'prepared/objects_durable',
        after_ref: 'prepared/objects_durable',
        after_refs_applied: 'prepared/refs_applied',
        before_ack: 'completed',
      });
    },
  );

  test(
    `${backend}: a receipt ref that holds another commit stops recovery, which never invents a target`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const kept = source.commit({ 'a.txt': 'a\n' });
      const tip = source.commit({ 'a.txt': 'b\n' });
      const f = await codeStoreFixture(t, backend);
      assert.equal((await f.deliver(source.bundle(kept))).status, 'completed');
      await f.open({ fault: faultAt('after_objects_durable') });
      await assert.rejects(f.deliver(source.bundle(tip, [kept]), 1024, 'stuck'), /process ended/);
      const [open] = (await f.code.status(f.admin)).operations;
      assert.equal(open.waiting!.code, 'internal_error');
      git(f.paths.repository, ['update-ref', `refs/merv/imports/${open.id}`, kept]);

      await f.open();
      const [stopped] = (await f.code.status(f.admin)).operations;
      assert.deepEqual(
        [stopped.id, stopped.status, stopped.phase],
        [open.id, 'prepared', 'objects_durable'],
      );
      assert.equal(stopped.waiting!.code, 'code_recovery_required');
      assert.match(stopped.waiting!.next, /operator inspects/);
      await assert.rejects(complete(f, open.id), { code: 'code_recovery_required', status: 409 });
      // Once an operator has put the ref right, the same operation completes.
      git(f.paths.repository, ['update-ref', '-d', `refs/merv/imports/${open.id}`]);
      assert.equal((await complete(f, open.id)).status, 'completed');
      assert.equal(git(f.paths.repository, ['rev-parse', `refs/merv/imports/${open.id}`]), tip);
    },
  );

  test(
    `${backend}: the lock of a ref its killed child left behind is taken away when the transaction is replayed`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const tip = source.commit({ 'a.txt': 'a\n' });
      const f = await codeStoreFixture(t, backend);
      await f.open({ fault: faultAt('after_objects_durable') });
      await assert.rejects(f.deliver(source.bundle(tip), 1024, 'stuck'), /process ended/);
      const [open] = (await f.code.status(f.admin)).operations;
      const imports = join(f.paths.repository, 'refs', 'merv', 'imports');

      // Git cannot write the ref at all. What it said is what the operator reads, instead of
      // a claim about a value the ref holds, which is another trouble with another recovery.
      mkdirSync(dirname(imports), { recursive: true });
      writeFileSync(imports, 'where the refs would go\n');
      await f.open();
      const [blocked] = (await f.code.status(f.admin)).operations;
      assert.deepEqual(
        [blocked.id, blocked.status, blocked.waiting!.code],
        [open.id, 'prepared', 'code_git_failed'],
      );
      assert.match(blocked.waiting!.message, /update-ref/);

      // The child was ended between `prepare` and `commit`, which leaves the ref's lock on
      // disk; every replay of the transaction is refused for as long as it lies there.
      rmSync(imports);
      mkdirSync(imports, { recursive: true });
      writeFileSync(join(imports, `${open.id}.lock`), `${tip}\n`);
      await f.open();
      assert.deepEqual(await f.operationRow(open.id), {
        status: 'completed',
        phase: 'refs_applied',
        error: null,
      });
      assert.equal(existsSync(join(imports, `${open.id}.lock`)), false);
      assert.equal(git(f.paths.repository, ['rev-parse', `refs/merv/imports/${open.id}`]), tip);
      assert.deepEqual((await f.code.status(f.admin)).operations, []);
    },
  );

  test(
    `${backend}: naming a main records whether the repository holds it, so nothing has to ask Git later`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const one = source.commit({ 'a.txt': 'one\n' });
      const two = source.commit({ 'a.txt': 'two\n' });
      const f = await codeStoreFixture(t, backend);
      // Main moves only for a signed-in administrator, so this project belongs to one.
      const principal = await f.scope.acceptVerifiedIdentity({
        issuer: 'https://identity.example/auth/v1',
        subject: 'owner',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const project = await f.scope.createProject(principal, { name: 'Human', requestId: 'p' });
      const human = await f.scope.caller(principal, project.id);
      const bind = async (mainOid: string, expectedMainOid?: string) =>
        await f.code.bindLocal(human, {
          repositoryId: 'operator-repository',
          mainOid,
          ...(expectedMainOid ? { expectedMainOid } : {}),
          requestId: `bind-${mainOid.slice(0, 8)}`,
        });
      assert.equal((await bind(two)).main.stored, false);
      const bundle = source.bundle(one);
      const begun = await f.code.importRepository(human, {
        source: 'bundle',
        tip: one,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId: 'import',
      });
      await f.code.v2!.putPart(human, begun.id, 0, bundle.content);
      await f.code.v2!.call(human, `uploads/${begun.id}/complete`, {});
      // Hosted, but main is a commit the import did not bring.
      let status = await f.code.status(human);
      assert.deepEqual([status.project!.durability, status.project!.main.stored], ['code', false]);
      // Naming a held commit says so at once; naming one that is not held says that too.
      assert.equal((await bind(one, two)).main.stored, true);
      assert.equal((await bind('c'.repeat(40), one)).main.stored, false);
      status = await f.code.status(human);
      assert.deepEqual(
        [status.project!.durability, status.project!.main.oid, status.project!.main.stored],
        ['code', 'c'.repeat(40), false],
      );
    },
  );

  test(
    `${backend}: a full volume or an exhausted quota refuses bytes and leaves the operation open`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const bundle = source.bundle(source.commit({ 'a.txt': 'a\n' }));
      const input = {
        source: 'bundle' as const,
        tip: bundle.tip,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId: 'one',
      };
      const small = await codeStoreFixture(t, backend, { quotaBytes: bundle.bytes - 1 });
      await assert.rejects(small.code.importRepository(small.admin, input), {
        code: 'code_store_full',
        status: 507,
      });
      assert.deepEqual((await small.code.status(small.admin)).operations, []);

      const starved = await codeStoreFixture(t, backend, {
        reservedFreeBytes: Number.MAX_SAFE_INTEGER,
      });
      await assert.rejects(starved.code.importRepository(starved.admin, input), {
        code: 'code_store_full',
      });

      // The volume fills while a transfer is under way: the part is refused, the operation stays.
      const f = await codeStoreFixture(t, backend);
      const begun = await f.code.importRepository(f.admin, input);
      await f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content.subarray(0, 100));
      await f.open({ config: { reservedFreeBytes: Number.MAX_SAFE_INTEGER } });
      await assert.rejects(
        f.code.v2!.putPart(f.admin, begun.id, 100, bundle.content.subarray(100)),
        { code: 'code_store_full', status: 507 },
      );
      assert.deepEqual(await f.operationRow(begun.id), {
        status: 'prepared',
        phase: 'receiving',
        error: null,
      });
      await f.open();
      assert.deepEqual(
        await f.code.v2!.putPart(f.admin, begun.id, 100, bundle.content.subarray(100)),
        {
          received: bundle.bytes,
        },
      );
      assert.equal((await complete(f, begun.id)).status, 'completed');
    },
  );

  test(
    `${backend}: findings refuse the whole import, keep its bundle for an operator, and a promise not kept keeps nothing`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const clean = source.commit({ 'a.txt': 'a\n' });
      const leaked = source.commit({
        'fixtures/token.txt': `${secret}\n`,
        'secrets/db.env': 'x\n',
      });
      const f = await codeStoreFixture(t, backend, { heldBundles: 1 });
      assert.deepEqual(
        await f.code.configureRepository(f.admin, {
          denyGlobs: ['secrets/**'],
          secretExemptGlobs: [],
          requestId: 'limits',
        }),
        { format: 1, denyGlobs: ['secrets/**'], secretExemptGlobs: [] },
      );
      const refused = await f.deliver(source.bundle(leaked));
      assert.deepEqual([refused.status, refused.error], ['failed', 'code_import_rejected']);
      assert.deepEqual(refused.findings.map(({ rule, path }) => [rule, path]).sort(), [
        ['credentials@1.github_token', 'fixtures/token.txt'],
        ['deny_glob', 'secrets/db.env'],
      ]);
      assert.equal(JSON.stringify(refused).includes(secret), false);
      // Nothing was admitted: no repository ref, no pack, and the project is not hosted.
      assert.deepEqual(f.refs(), []);
      assert.deepEqual(readdirSync(join(f.paths.repository, 'objects', 'pack')), []);
      const status = await f.code.status(f.admin);
      assert.equal(status.store!.hosted, false);
      assert.deepEqual(
        status.operations.map((operation) => [operation.id, operation.findings.length]),
        [[refused.id, 2]],
      );
      // The bundle is kept where no route serves it.
      assert.deepEqual(readdirSync(f.paths.held), [`${refused.id}.bundle`]);
      assert.equal(statSync(join(f.paths.held, `${refused.id}.bundle`)).mode & 0o777, 0o600);
      assert.equal(existsSync(join(f.paths.quarantine, refused.id)), false);
      await assert.rejects(f.code.v2!.putPart(f.admin, refused.id, 0, Buffer.from('x')), {
        code: 'code_upload_closed',
      });

      // The project exempts its fixtures and stops denying; the replayed request is still the refusal.
      await assert.rejects(
        f.code.configureRepository(f.admin, {
          denyGlobs: [],
          secretExemptGlobs: [],
          requestId: 'limits',
        }),
        { code: 'request_conflict' },
      );
      await f.code.configureRepository(f.admin, {
        denyGlobs: [],
        secretExemptGlobs: ['fixtures/**'],
        requestId: 'limits-2',
      });
      assert.deepEqual((await f.code.status(f.admin)).store!.limits, {
        format: 1,
        denyGlobs: [],
        secretExemptGlobs: ['fixtures/**'],
      });
      assert.equal((await f.deliver(source.bundle(leaked), 1024, 'import-1')).status, 'failed');
      assert.equal((await f.deliver(source.bundle(leaked), 1024, 'exempted')).status, 'completed');

      // A second refusal makes room by dropping the oldest held bundle.
      const again = source.commit({ 'other.txt': `copied = ${secret}\n` });
      const second = await f.deliver(source.bundle(again, [leaked]));
      assert.equal(second.error, 'code_import_rejected');
      assert.deepEqual(readdirSync(f.paths.held), [`${second.id}.bundle`]);

      // A bundle that does not deliver what was promised is dropped, not held.
      const other = source.bundle(clean);
      const lied = await f.deliver({ ...other, tip: leaked });
      assert.deepEqual([lied.status, lied.error], ['failed', 'code_bundle_head']);
      assert.deepEqual(readdirSync(f.paths.held), [`${second.id}.bundle`]);
      assert.equal(existsSync(join(f.paths.quarantine, lied.id)), false);

      // Bytes that are not the promised bytes are dropped and sent again.
      source.git('reset', '--quiet', '--hard', leaked);
      const fresh = source.commit({ 'fine.txt': 'fine\n' });
      const wanted = source.bundle(fresh, [leaked]);
      const begun = await f.code.importRepository(f.admin, {
        source: 'bundle',
        tip: fresh,
        bundle: { sha256: wanted.sha256, bytes: wanted.bytes },
        requestId: 'garbled',
      });
      const garbled = Buffer.from(wanted.content);
      garbled[garbled.length - 1] ^= 1;
      await f.code.v2!.putPart(f.admin, begun.id, 0, garbled);
      await assert.rejects(complete(f, begun.id), {
        code: 'code_bundle_hash_mismatch',
        status: 409,
      });
      assert.equal(
        (
          (await f.code.v2!.call(f.admin, `uploads/${begun.id}`, {})) as {
            operation: CodeStoreOperation;
          }
        ).operation.received,
        0,
      );
      await f.code.v2!.putPart(f.admin, begun.id, 0, wanted.content);
      assert.equal((await complete(f, begun.id)).status, 'completed');
    },
  );

  test(
    `${backend}: a ref of the linked repository is fetched into quarantine and admitted like any bundle`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const one = source.commit({ 'a.txt': 'a\n' });
      const seen: Record<string, string>[] = [];
      const remote: CodeImportRemote = {
        read: async (_caller, use) =>
          await use({
            url: `file://${source.repository}`,
            protocol: 'file',
            repository: { id: 4242, fullName: 'fixture/source' },
            env: {
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'http.extraheader',
              GIT_CONFIG_VALUE_0: 'Authorization: Basic fixture-token',
            },
          }).then((result) => (seen.push({ used: 'yes' }), result)),
      };
      const f = await codeStoreFixture(t, backend, {}, one);
      await f.open({ remote });
      const imported = await f.code.importRepository(f.admin, {
        source: 'github',
        ref: 'refs/heads/main',
        requestId: 'github-1',
      });
      assert.deepEqual([imported.status, imported.head, imported.error], ['completed', one, null]);
      assert.equal(seen.length, 1);
      // Only the import ref exists: no remote-tracking ref, tag or FETCH_HEAD reached the repository.
      assert.deepEqual(f.refs(), [`refs/merv/imports/${imported.id} ${one}`]);
      assert.equal(existsSync(join(f.paths.repository, 'FETCH_HEAD')), false);
      assert.equal(
        readFileSync(join(f.paths.repository, 'config'), 'utf8').includes('fixture-token'),
        false,
      );
      const status = await f.code.status(f.admin);
      assert.deepEqual([status.store!.source, status.project!.main.stored], ['github', true]);
      const stored = await f.state.read(
        async (sql) =>
          await sql.get<{ store_json: string }>(
            'SELECT store_json FROM code_projects WHERE project_id=?',
            f.admin.projectId,
          ),
      );
      assert.equal(JSON.parse(stored!.store_json).githubRepositoryId, 4242);
      assert.equal(stored!.store_json.includes('fixture-token'), false);

      // Nothing new on the ref is said plainly; new history arrives as a continuation.
      const current = await f.code.importRepository(f.admin, {
        source: 'github',
        ref: 'refs/heads/main',
        requestId: 'github-2',
      });
      assert.deepEqual([current.status, current.error], ['failed', 'code_import_current']);
      const two = source.commit({ 'a.txt': 'two\n' });
      const next = await f.code.importRepository(f.admin, {
        source: 'github',
        ref: 'refs/heads/main',
        requestId: 'github-3',
      });
      assert.deepEqual([next.status, next.head], ['completed', two]);
      const missing = await f.code.importRepository(f.admin, {
        source: 'github',
        ref: 'refs/heads/absent',
        requestId: 'github-4',
      });
      assert.deepEqual([missing.status, missing.error], ['failed', 'code_import_fetch_failed']);
      // History GitHub delivers is examined exactly as an upload is.
      source.commit({ 'leak.txt': `${secret}\n` });
      const leaked = await f.code.importRepository(f.admin, {
        source: 'github',
        ref: 'refs/heads/main',
        requestId: 'github-5',
      });
      assert.deepEqual(
        [leaked.status, leaked.error, leaked.findings.length],
        ['failed', 'code_import_rejected', 1],
      );
      assert.deepEqual(readdirSync(f.paths.quarantine), []);
    },
  );

  test(
    `${backend}: unloading Code waits for the admission that is running, then gives up the lock`,
    optional(backend),
    async (t) => {
      const source = gitSource(t);
      const one = source.commit({
        'README.md': 'one\n',
        'rows.txt': Array.from({ length: 20_000 }, (_, index) => `row ${index}`).join('\n'),
      });
      const f = await codeStoreFixture(t, backend, { settleMs: 1 }, one);
      const bundle = source.bundle(one);
      const begun = await f.code.importRepository(f.admin, {
        source: 'bundle',
        tip: one,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId: 'drain',
      });
      await f.code.v2!.putPart(f.admin, begun.id, 0, bundle.content);
      // The admission outlives the call that started it; unloading is asked for at once.
      const admitting = complete(f, begun.id);
      await f.code.close();
      await admitting.catch(() => {});
      const after = (await f.operationRow(begun.id))!;
      assert.ok(
        after.status === 'completed' || after.phase !== null,
        'it either finished or said where it stopped',
      );

      // The lock is given up either way, so the next start takes it and finishes the work.
      await f.open();
      let settled = await complete(f, begun.id);
      for (let tries = 0; settled.status === 'prepared' && tries < 200; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        settled = await complete(f, begun.id);
      }
      assert.equal(settled.status, 'completed');
      assert.equal((await f.code.status(f.admin)).store!.hosted, true);
      assert.deepEqual(f.refs(), [`refs/merv/imports/${begun.id} ${one}`]);
    },
  );
}
