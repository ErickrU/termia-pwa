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
  identitySha256,
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

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePrivateJson(path, value) {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCapture(directory, prefix, { stdout = '', stderr = '', exitCode, requestedAt, respondedAt }) {
  const stdoutBytes = Buffer.from(stdout);
  const stderrBytes = Buffer.from(stderr);
  writePrivate(join(directory, `${prefix}.stdout`), stdoutBytes);
  writePrivate(join(directory, `${prefix}.stderr`), stderrBytes);
  writePrivateJson(join(directory, `${prefix}.capture.json`), {
    requestedAt,
    respondedAt,
    exitCode,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes)
  });
}

function runCli(argumentsList) {
  return spawnSync(process.execPath, [cli, ...argumentsList], { encoding: 'utf8' });
}

function utc(base, seconds) {
  return new Date(base + (seconds * 1000)).toISOString().replace('.000Z', 'Z');
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
  assert.match(block, /--description "Termia template \$TEMPLATE_SHA"/);
  assert.doesNotMatch(block, /--disable-rollback/i);
  assert.doesNotMatch(block, /--(?:capabilities|include-nested-stacks|import-existing-resources|notification-arns|resource-types|resources-to-import|role-arn|rollback-configuration|template-url)\b/i);
});

test('normaliza la identidad y captura el request ID antes de crear', () => {
  const normalizeIndex = script.indexOf('normalize-identity');
  const createIndex = script.indexOf('capture_command create-change-set');
  assert.ok(normalizeIndex >= 0 && normalizeIndex < createIndex);
  assert.match(script, /capture_command preflight-describe-stacks "\$\{AWS\[@\]\}" --debug cloudformation describe-stacks/);
  assert.match(script, /--probe-prefix preflight-describe-stacks/);
  assert.match(script, /--identity "\$ATTEMPT_DIR\/identity\.json"/);
});

test('repite el guard TOCTOU con el timestamp capturado inmediatamente antes de execute', () => {
  const block = script.match(/EXECUTE_REQUESTED_AT="\$\(utc_now\)"[\s\S]+?require_capture_success 'CloudFormation no aceptó la ejecución;/)?.[0];
  assert.ok(block, 'debe existir el guard final ligado a execute');
  assert.match(block, /guard-execute[\s\S]+?--requested-at "\$EXECUTE_REQUESTED_AT"/);
  assert.match(block, /capture_command_at execute-change-set "\$EXECUTE_REQUESTED_AT"/);
  assert.match(block, /verify-execute-capture/);
  assert.doesNotMatch(block, /\b(?:report|seal)\b/);
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

test('build y validate completan un intento sintético con identidad persistida', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'termia-proof-build-'));
  try {
    chmodSync(temporary, 0o700);
    const attemptsRoot = join(temporary, 'attempts');
    const templatePath = join(temporary, 'template.yaml');
    const templateBytes = Buffer.from('Resources:\n', 'ascii');
    writePrivate(templatePath, templateBytes);

    const accountId = ['123456', '789012'].join('');
    const partition = ['a', 'ws'].join('');
    const identity = {
      accountId,
      principalArn: `arn:${partition}:sts::${accountId}:assumed-role/FixtureRole/fixture-session`,
      userId: ['fixture', 'user'].join('-'),
      profile: 'fixture-profile',
      region: 'us-east-1'
    };
    const identityHash = identitySha256(identity);
    const initialized = runCli([
      'init-attempt',
      '--attempts-root', attemptsRoot,
      '--template', templatePath,
      '--profile', identity.profile,
      '--region', identity.region,
      '--commit-sha', 'a'.repeat(40),
      '--confirm-commit-sha', 'a'.repeat(40),
      '--confirm-identity-sha', identityHash
    ]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const attemptDirectory = initialized.stdout.trim();
    const attempt = JSON.parse(readFileSync(join(attemptDirectory, 'attempt.json'), 'utf8'));
    const base = Date.parse(attempt.createdAt);
    const at = (seconds) => utc(base, seconds);
    const rawIdentity = { Account: accountId, Arn: identity.principalArn, UserId: identity.userId };

    writeCapture(attemptDirectory, 'identity', {
      stdout: `${JSON.stringify(rawIdentity)}\n`,
      exitCode: 0,
      requestedAt: at(0),
      respondedAt: at(0)
    });
    const normalized = runCli([
      'normalize-identity',
      '--attempt', join(attemptDirectory, 'attempt.json'),
      '--identity', join(attemptDirectory, 'identity.stdout'),
      '--output', join(attemptDirectory, 'identity.json')
    ]);
    assert.equal(normalized.status, 0, normalized.stderr);
    assert.equal(mode(join(attemptDirectory, 'identity.json')), 0o600);
    writePrivate(join(attemptDirectory, 'commit-template.yaml'), templateBytes);

    const absenceRequestId = 'fixture-describe-request';
    writeCapture(attemptDirectory, 'preflight-describe-stacks', {
      stderr: `DEBUG Response headers: {'x-amzn-requestid': '${absenceRequestId}'}\nAn error occurred (ValidationError) when calling DescribeStacks: stack does not exist\n`,
      exitCode: 254,
      requestedAt: at(1),
      respondedAt: at(2)
    });
    writeCapture(attemptDirectory, 'preflight-list-change-sets', {
      stderr: 'An error occurred (ValidationError) when calling ListChangeSets: stack does not exist\n',
      exitCode: 254,
      requestedAt: at(2),
      respondedAt: at(3)
    });

    const deploymentId = sha256(`${accountId}:${identity.region}:${CONTRACT.stackName}`).slice(0, 10);
    const parameters = [
      { ParameterKey: 'ProjectSlug', ParameterValue: CONTRACT.project },
      { ParameterKey: 'Environment', ParameterValue: CONTRACT.environment },
      { ParameterKey: 'DeploymentId', ParameterValue: deploymentId },
      { ParameterKey: 'PriceClass', ParameterValue: CONTRACT.priceClass }
    ];
    const tags = [
      { Key: 'Project', Value: CONTRACT.project },
      { Key: 'Environment', Value: CONTRACT.environment },
      { Key: 'ManagedBy', Value: 'CloudFormation' },
      { Key: 'Repository', Value: CONTRACT.repository },
      { Key: 'DeploymentId', Value: deploymentId }
    ];
    writePrivateJson(join(attemptDirectory, 'create-request.json'), {
      operation: 'CreateChangeSet',
      requestedAt: at(4),
      profile: identity.profile,
      region: identity.region,
      stackName: CONTRACT.stackName,
      changeSetName: attempt.changeSetName,
      changeSetType: 'CREATE',
      clientToken: attempt.clientToken,
      description: `Termia template ${sha256(templateBytes)}`,
      onStackFailure: 'DO_NOTHING',
      disableRollback: false,
      includeNestedStacks: false,
      importExistingResources: false,
      capabilities: [],
      notificationArns: [],
      roleArn: null,
      resourceTypes: [],
      resourcesToImport: [],
      rollbackConfiguration: null,
      templateUrl: null,
      templateSha256: sha256(templateBytes),
      parameters,
      tags
    });

    const stackId = `fixture-stack/${CONTRACT.stackName}`;
    const changeSetId = `fixture-change/${attempt.changeSetName}`;
    writeCapture(attemptDirectory, 'create-change-set', {
      stdout: `${JSON.stringify({ Id: changeSetId, StackId: stackId })}\n`,
      exitCode: 0,
      requestedAt: at(5),
      respondedAt: at(6)
    });
    writePrivateJson(join(attemptDirectory, 'cloudtrail-describe-event.json'), {
      eventName: 'DescribeStacks',
      eventTime: at(2),
      eventID: 'fixture-absence-event',
      requestID: absenceRequestId,
      awsRegion: identity.region,
      recipientAccountId: accountId,
      userIdentity: { arn: identity.principalArn },
      errorCode: 'ValidationError',
      requestParameters: { stackName: CONTRACT.stackName },
      responseElements: null
    });
    writePrivateJson(join(attemptDirectory, 'cloudtrail-create-event.json'), {
      eventName: 'CreateChangeSet',
      eventTime: at(5),
      eventID: 'fixture-create-event',
      requestID: 'fixture-create-request',
      awsRegion: identity.region,
      recipientAccountId: accountId,
      userIdentity: { arn: identity.principalArn },
      requestParameters: {
        stackName: CONTRACT.stackName,
        changeSetName: attempt.changeSetName,
        changeSetType: 'CREATE',
        clientToken: attempt.clientToken,
        description: `Termia template ${sha256(templateBytes)}`,
        onStackFailure: 'DO_NOTHING',
        parameters,
        tags
      },
      responseElements: { id: changeSetId, stackId }
    });

    const changes = Object.entries(CONTRACT.logicalResources).map(([LogicalResourceId, ResourceType]) => ({
      Type: 'Resource',
      ResourceChange: {
        Action: 'Add',
        LogicalResourceId,
        ResourceType,
        Replacement: null,
        Scope: [],
        Details: []
      }
    }));
    const snapshots = {
      'describe-change-set': {
        ChangeSetName: attempt.changeSetName,
        ChangeSetId: changeSetId,
        StackName: CONTRACT.stackName,
        StackId: stackId,
        Description: `Termia template ${sha256(templateBytes)}`,
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE',
        OnStackFailure: 'DO_NOTHING',
        DeploymentConfig: { DisableRollback: false, Mode: 'STANDARD' },
        IncludeNestedStacks: false,
        ImportExistingResources: false,
        Capabilities: [],
        Parameters: parameters,
        Tags: tags,
        Changes: changes
      },
      'list-change-sets': {
        Summaries: [{
          ChangeSetName: attempt.changeSetName,
          ChangeSetId: changeSetId,
          Status: 'CREATE_COMPLETE',
          ExecutionStatus: 'AVAILABLE'
        }]
      },
      'describe-stacks': {
        Stacks: [{
          StackName: CONTRACT.stackName,
          StackId: stackId,
          StackStatus: 'REVIEW_IN_PROGRESS',
          DisableRollback: false,
          Parameters: [],
          Outputs: []
        }]
      },
      'list-stack-resources': { StackResourceSummaries: [] },
      'get-change-template': { TemplateBody: templateBytes.toString('utf8') }
    };
    let captureSecond = 7;
    for (const [name, document] of Object.entries(snapshots)) {
      writeCapture(attemptDirectory, `prepare-${name}`, {
        stdout: `${JSON.stringify(document)}\n`,
        exitCode: 0,
        requestedAt: at(captureSecond),
        respondedAt: at(captureSecond + 1)
      });
      captureSecond += 1;
    }
    writeCapture(attemptDirectory, 'prepare-get-stack-template', {
      stderr: 'An error occurred (ValidationError) when calling GetTemplate\n',
      exitCode: 254,
      requestedAt: at(12),
      respondedAt: at(13)
    });

    const chainPath = join(attemptDirectory, 'chain-input-prepare.json');
    const sealed = runCli([
      'seal', '--attempt-dir', attemptDirectory, '--output-name', 'chain-input-prepare.json'
    ]);
    assert.equal(sealed.status, 0, sealed.stderr);
    const evidencePath = join(attemptDirectory, 'proof-prepare.json');
    const built = runCli([
      'build', '--phase', 'prepare', '--attempt-dir', attemptDirectory,
      '--input-chain', chainPath, '--output', evidencePath
    ]);
    assert.equal(built.status, 0, built.stderr);
    const validated = runCli([
      'validate',
      '--phase', 'prepare',
      '--evidence', evidencePath,
      '--template', templatePath,
      '--commit-template', join(attemptDirectory, 'commit-template.yaml'),
      '--chain', chainPath,
      '--expected-commit-sha', 'a'.repeat(40),
      '--expected-identity-sha', identityHash,
      '--now', at(15)
    ]);
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(validated.stdout, /AWS proof: PASS/);
    const proof = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(proof.identity.principalArn, identity.principalArn);
    assert.equal(proof.create.response.requestedAt, at(5));
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
