import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT,
  buildShareableReport,
  createAttemptRecord,
  sha256,
  validateCliSkeleton,
  validateShareableReport
} from '../scripts/aws-proof.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = readFileSync(join(root, 'scripts', 'deploy-aws.sh'), 'utf8');
const cli = join(root, 'scripts', 'validate-aws-proof.mjs');

function mode(path) {
  return statSync(path).mode & 0o777;
}

test('el target y sus parámetros de producción están fijados internamente', () => {
  assert.match(script, /^TARGET_STACK='termia-pwa-public-prod'$/m);
  assert.match(script, /^ENVIRONMENT='prod'$/m);
  assert.match(script, /^PRICE_CLASS='PriceClass_100'$/m);
  assert.doesNotMatch(script, /--stack\)/);
  assert.doesNotMatch(script, /--environment\)/);
  assert.doesNotMatch(script, /--price-class\)/);
  assert.match(script, /el resultado siempre es STOP/);
  assert.doesNotMatch(script, /cloudformation\s+(?:delete-stack|update-stack)/);
});

test('create-change-set usa CREATE, token interno y DO_NOTHING sin DisableRollback', () => {
  const block = script.match(/capture_command create-change-set[\s\S]+?require_capture_success 'No se pudo preparar el change set;/)?.[0];
  assert.ok(block, 'debe existir el bloque literal de creación');
  assert.match(block, /--change-set-type CREATE/);
  assert.match(block, /--client-token "\$CLIENT_TOKEN"/);
  assert.match(block, /--on-stack-failure DO_NOTHING/);
  assert.match(block, /--change-set-name "\$CHANGE_SET_NAME"/);
  assert.doesNotMatch(block, /--disable-rollback/i);
});

test('el nombre y token se generan una vez y no aceptan entrada externa', () => {
  const values = [
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'ffffffff-aaaa-4bbb-8ccc-dddddddddddd'
  ];
  const template = Buffer.from('Resources:\n', 'ascii');
  const record = createAttemptRecord({
    profile: 'fixture-profile',
    region: 'us-east-1',
    commitSha: 'a'.repeat(40),
    confirmedCommitSha: 'a'.repeat(40),
    confirmedIdentitySha: 'b'.repeat(64),
    templateBytes: template,
    now: new Date('2026-10-16T12:00:00Z'),
    uuidFactory: () => values.shift(),
    stackName: 'untrusted-stack',
    changeSetName: 'untrusted-change',
    clientToken: 'untrusted-token'
  });
  assert.equal(record.stackName, CONTRACT.stackName);
  assert.equal(record.changeSetName, 'termia-pwa-create-20261016T120000Z-aaaaaaaabbbb');
  assert.equal(record.clientToken, 'termia-pwa-ffffffff-aaaa-4bbb-8ccc-dddddddddddd');
});

test('el skeleton local exige ClientToken y OnStackFailure', () => {
  const skeleton = JSON.parse(readFileSync(join(here, 'fixtures', 'aws-proof', 'create-change-set-cli-v2-skeleton.json'), 'utf8'));
  assert.equal(validateCliSkeleton(skeleton), true);
  delete skeleton.ClientToken;
  assert.throws(() => validateCliSkeleton(skeleton), (error) => error?.code === 'CLI_SKELETON');
});

test('la evidencia se crea 0700/0600 y rechaza reintentos y sobrescritura', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'termia-proof-contract-'));
  try {
    chmodSync(temporary, 0o700);
    const attemptsRoot = join(temporary, 'attempts');
    const template = join(temporary, 'template.yaml');
    writeFileSync(template, 'Resources:\n', { mode: 0o600 });
    const baseArguments = [
      cli, 'init-attempt',
      '--attempts-root', attemptsRoot,
      '--template', template,
      '--profile', 'fixture-profile',
      '--region', 'us-east-1',
      '--commit-sha', 'a'.repeat(40),
      '--confirm-commit-sha', 'a'.repeat(40),
      '--confirm-identity-sha', 'b'.repeat(64)
    ];
    const initialized = spawnSync(process.execPath, baseArguments, { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const attemptDirectory = initialized.stdout.trim();
    assert.equal(mode(attemptsRoot), 0o700);
    assert.equal(mode(attemptDirectory), 0o700);
    assert.equal(mode(join(attemptDirectory, 'attempt.json')), 0o600);
    assert.equal(mode(join(attemptDirectory, 'submitted-template.yaml')), 0o600);

    const retry = spawnSync(process.execPath, baseArguments, { encoding: 'utf8' });
    assert.notEqual(retry.status, 0);

    const sealed = spawnSync(process.execPath, [
      cli, 'seal', '--attempt-dir', attemptDirectory, '--output-name', 'chain.json'
    ], { encoding: 'utf8' });
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.equal(mode(join(attemptDirectory, 'chain.json')), 0o600);
    const overwrite = spawnSync(process.execPath, [
      cli, 'seal', '--attempt-dir', attemptDirectory, '--output-name', 'chain.json'
    ], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('los reportes compartibles admiten únicamente hashes y booleanos', () => {
  const report = buildShareableReport({
    evidenceBytes: Buffer.from('evidence'),
    chainBytes: Buffer.from('chain'),
    proofSummary: {
      absenceCorrelated: true,
      createCorrelated: true,
      fiveAllowedAdds: true,
      fixedTarget: true,
      identityMatched: true,
      templateCanonical: true,
      toctouFresh: true
    },
    templateSha256: sha256('template'),
    commitSha: 'a'.repeat(40),
    identityHash: sha256('identity')
  });
  assert.equal(validateShareableReport(report), true);
  assert.throws(
    () => validateShareableReport({ ...report, leaked: 'termia-pwa-public-prod' }),
    (error) => error?.code === 'REPORT_REDACTION'
  );
});

test('los estados privados y el directorio por intento están ignorados', () => {
  const ignored = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignored, /^\.aws-attempts\/$/m);
  assert.match(ignored, /^\.aws-change-set\.json$/m);
  assert.match(ignored, /^\.aws-deployment\.json$/m);
});
