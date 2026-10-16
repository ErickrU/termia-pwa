import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT,
  identitySha256,
  sha256,
  validateAwsProof,
  validateCanonicalTemplateBytes
} from '../scripts/aws-proof.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(here, 'fixtures', 'aws-proof');
const templateBytes = Buffer.from('Resources:\n', 'ascii');
const accountId = ['123456', '789012'].join('');
const partition = ['a', 'ws'].join('');
const principalArn = `arn:${partition}:sts::${accountId}:assumed-role/FixtureRole/fixture-session`;
const commitSha = 'a'.repeat(40);
const inputChainSha256 = 'b'.repeat(64);
const clientToken = ['termia', 'fixture', 'client', 'token'].join('-');
const attemptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const changeSetName = 'termia-pwa-create-20261016T120000Z-abcdefabcdef';
const stackId = `arn:${partition}:cloudformation:us-east-1:${accountId}:stack/${CONTRACT.stackName}/fixture-stack`;
const changeSetId = `arn:${partition}:cloudformation:us-east-1:${accountId}:changeSet/${changeSetName}/fixture-change`;
const deploymentId = sha256(`${accountId}:us-east-1:${CONTRACT.stackName}`).slice(0, 10);

const identity = {
  accountId,
  principalArn,
  userId: ['fixture', 'user'].join('-'),
  profile: 'fixture-profile',
  region: 'us-east-1'
};
const identityHash = identitySha256(identity);

function parameters() {
  return [
    { ParameterKey: 'ProjectSlug', ParameterValue: CONTRACT.project },
    { ParameterKey: 'Environment', ParameterValue: CONTRACT.environment },
    { ParameterKey: 'DeploymentId', ParameterValue: deploymentId },
    { ParameterKey: 'PriceClass', ParameterValue: CONTRACT.priceClass }
  ];
}

function tags() {
  return [
    { Key: 'Project', Value: CONTRACT.project },
    { Key: 'Environment', Value: CONTRACT.environment },
    { Key: 'ManagedBy', Value: 'CloudFormation' },
    { Key: 'Repository', Value: CONTRACT.repository },
    { Key: 'DeploymentId', Value: deploymentId }
  ];
}

function changes() {
  return Object.entries(CONTRACT.logicalResources).map(([LogicalResourceId, ResourceType]) => ({
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
}

function snapshot(purpose, startedAt, observedAt) {
  return {
    purpose,
    startedAt,
    observedAt,
    identity: { ...identity },
    describeChangeSet: {
      ChangeSetName: changeSetName,
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
      Parameters: parameters(),
      Tags: tags(),
      Changes: changes()
    },
    listChangeSets: {
      Summaries: [{
        ChangeSetName: changeSetName,
        ChangeSetId: changeSetId,
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE'
      }]
    },
    describeStacks: {
      Stacks: [{
        StackName: CONTRACT.stackName,
        StackId: stackId,
        StackStatus: 'REVIEW_IN_PROGRESS',
        DisableRollback: false,
        Parameters: [],
        Outputs: []
      }]
    },
    listStackResources: { StackResourceSummaries: [] },
    stackTemplateAbsence: {
      operation: 'GetTemplate',
      stackId,
      profile: identity.profile,
      region: identity.region,
      identitySha256: identityHash,
      absent: true,
      errorCode: 'ValidationError',
      exitCode: 254,
      requestedAt: startedAt,
      respondedAt: observedAt,
      stdoutSha256: sha256(''),
      stderrSha256: sha256('synthetic error')
    },
    remoteTemplateBodyBase64: templateBytes.toString('base64'),
    remoteTemplateSha256: sha256(templateBytes)
  };
}

function validProof() {
  const context = {
    schemaVersion: 1,
    attemptId,
    createdAt: '2026-10-16T12:00:00Z',
    project: CONTRACT.project,
    repository: CONTRACT.repository,
    stackName: CONTRACT.stackName,
    environment: CONTRACT.environment,
    priceClass: CONTRACT.priceClass,
    profile: identity.profile,
    region: identity.region,
    commitSha,
    confirmedCommitSha: commitSha,
    confirmedIdentitySha: identityHash,
    templateSha256: sha256(templateBytes),
    templateByteLength: templateBytes.length,
    changeSetName,
    clientToken,
    gitClean: true,
    identitySha256: identityHash,
    deploymentId
  };
  return {
    schemaVersion: 1,
    phase: 'execute',
    context,
    integrity: { inputChainSha256 },
    template: {
      localBodyBase64: templateBytes.toString('base64'),
      commitBodyBase64: templateBytes.toString('base64'),
      localSha256: sha256(templateBytes),
      commitSha256: sha256(templateBytes),
      byteLength: templateBytes.length
    },
    identity: { ...identity },
    preflight: {
      describeStacks: {
        operation: 'DescribeStacks',
        stackName: CONTRACT.stackName,
        profile: identity.profile,
        region: identity.region,
        identitySha256: identityHash,
        absent: true,
        errorCode: 'ValidationError',
        exitCode: 254,
        requestId: 'fixture-absence-request',
        requestedAt: '2026-10-16T12:00:05Z',
        respondedAt: '2026-10-16T12:00:06Z',
        stdoutSha256: sha256(''),
        stderrSha256: sha256('synthetic describe error')
      },
      listChangeSets: {
        operation: 'ListChangeSets',
        stackName: CONTRACT.stackName,
        profile: identity.profile,
        region: identity.region,
        identitySha256: identityHash,
        absent: true,
        errorCode: 'ValidationError',
        exitCode: 254,
        requestedAt: '2026-10-16T12:00:07Z',
        respondedAt: '2026-10-16T12:00:08Z',
        stdoutSha256: sha256(''),
        stderrSha256: sha256('synthetic list error')
      },
      cloudTrailDescribeStacks: {
        eventName: 'DescribeStacks',
        eventTime: '2026-10-16T12:00:06Z',
        eventId: 'fixture-absence-event',
        requestId: 'fixture-absence-request',
        awsRegion: identity.region,
        recipientAccountId: accountId,
        principalArn,
        errorCode: 'ValidationError',
        requestParameters: { stackName: CONTRACT.stackName },
        responseElements: null,
        stackName: CONTRACT.stackName
      }
    },
    create: {
      request: {
        operation: 'CreateChangeSet',
        requestedAt: '2026-10-16T12:00:10Z',
        profile: identity.profile,
        region: identity.region,
        stackName: CONTRACT.stackName,
        changeSetName,
        changeSetType: 'CREATE',
        clientToken,
        onStackFailure: 'DO_NOTHING',
        disableRollback: false,
        includeNestedStacks: false,
        importExistingResources: false,
        capabilities: [],
        notificationArns: [],
        roleArn: null,
        templateSha256: sha256(templateBytes),
        parameters: parameters(),
        tags: tags()
      },
      response: {
        changeSetId,
        stackId,
        requestedAt: '2026-10-16T12:00:10Z',
        respondedAt: '2026-10-16T12:00:12Z',
        stdoutSha256: sha256('synthetic response'),
        stderrSha256: sha256('')
      },
      cloudTrailCreateChangeSet: {
        eventName: 'CreateChangeSet',
        eventTime: '2026-10-16T12:00:11Z',
        eventId: 'fixture-create-event',
        requestId: 'fixture-create-request',
        awsRegion: identity.region,
        recipientAccountId: accountId,
        principalArn,
        errorCode: null,
        requestParameters: {
          stackName: CONTRACT.stackName,
          changeSetName,
          changeSetType: 'CREATE',
          clientToken,
          onStackFailure: 'DO_NOTHING',
          parameters: parameters(),
          tags: tags()
        },
        responseElements: { id: changeSetId, stackId }
      }
    },
    snapshots: {
      prepare: snapshot('prepare-review', '2026-10-16T12:00:20Z', '2026-10-16T12:00:25Z'),
      toctou: snapshot('before-execute', '2026-10-16T12:01:00Z', '2026-10-16T12:01:05Z')
    }
  };
}

function validationOptions(now = '2026-10-16T12:01:10Z') {
  return {
    phase: 'execute',
    templateBytes,
    commitTemplateBytes: templateBytes,
    expectedCommitSha: commitSha,
    expectedIdentitySha: identityHash,
    inputChainSha256,
    now
  };
}

function applyMutation(proof, mutation) {
  switch (mutation) {
    case null: return;
    case 'remote-question-mark': {
      const changed = Buffer.from('Resources?\n', 'ascii');
      proof.snapshots.prepare.remoteTemplateBodyBase64 = changed.toString('base64');
      proof.snapshots.prepare.remoteTemplateSha256 = sha256(changed);
      return;
    }
    case 'missing-client-token': proof.create.request.clientToken = null; return;
    case 'wrong-stack-state': proof.snapshots.prepare.describeStacks.Stacks[0].StackStatus = 'CREATE_IN_PROGRESS'; return;
    case 'extra-action': {
      proof.snapshots.prepare.describeChangeSet.Changes.push({
        Type: 'Resource',
        ResourceChange: { Action: 'Add', LogicalResourceId: 'Unexpected', ResourceType: 'AWS::S3::Bucket' }
      });
      return;
    }
    case 'on-stack-failure-delete': proof.create.request.onStackFailure = 'DELETE'; return;
    case 'on-stack-failure-null': proof.create.request.onStackFailure = null; return;
    case 'stale-timestamp': return;
    case 'identity-mismatch': proof.snapshots.toctou.identity.principalArn = `${principalArn}-different`; return;
    case 'absence-request-id-mismatch': proof.preflight.cloudTrailDescribeStacks.requestId = 'fixture-unrelated-request'; return;
    case 'stale-preflight-capture':
      proof.create.response.requestedAt = '2026-10-16T12:01:09Z';
      proof.create.response.respondedAt = '2026-10-16T12:01:11Z';
      proof.create.cloudTrailCreateChangeSet.eventTime = '2026-10-16T12:01:10Z';
      return;
    case 'missing-absence-source': delete proof.preflight.listChangeSets; return;
    case 'remote-lf-mismatch': {
      const changed = Buffer.concat([templateBytes, Buffer.from('\n')]);
      proof.snapshots.prepare.remoteTemplateBodyBase64 = changed.toString('base64');
      proof.snapshots.prepare.remoteTemplateSha256 = sha256(changed);
      return;
    }
    case 'contradictory-change-set-type': proof.snapshots.prepare.describeChangeSet.ChangeSetType = 'UPDATE'; return;
    default: throw new Error(`Mutación desconocida: ${mutation}`);
  }
}

const fixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith('.json') && name !== 'create-change-set-cli-v2-skeleton.json')
  .map((name) => JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')));

for (const fixture of fixtures) {
  test(`fixture ${fixture.name}`, () => {
    const proof = validProof();
    applyMutation(proof, fixture.mutation);
    const options = validationOptions(fixture.mutation === 'stale-timestamp' ? '2026-10-16T12:10:00Z' : undefined);
    if (fixture.expectedCode === 'PASS') {
      const result = validateAwsProof(proof, options);
      assert.equal(result.fiveAllowedAdds, true);
      assert.equal(result.toctouFresh, true);
      assert.equal(Object.hasOwn(proof.snapshots.prepare.describeChangeSet, 'ChangeSetType'), false);
      return;
    }
    assert.throws(
      () => validateAwsProof(proof, options),
      (error) => error?.code === fixture.expectedCode,
      `debe fallar exactamente con ${fixture.expectedCode}`
    );
  });
}

test('acepta ChangeSetType ausente o nulo, pero nunca contradictorio', () => {
  const proof = validProof();
  proof.snapshots.prepare.describeChangeSet.ChangeSetType = null;
  proof.snapshots.toctou.describeChangeSet.ChangeSetType = null;
  assert.equal(validateAwsProof(proof, validationOptions()).createCorrelated, true);
});

test('execute falla cerrado si falta el snapshot TOCTOU', () => {
  const proof = validProof();
  delete proof.snapshots.toctou;
  assert.throws(() => validateAwsProof(proof, validationOptions()), (error) => error?.code === 'TOCTOU_REQUIRED');
});

test('el guard final rechaza una demora posterior al primer PASS', () => {
  const proof = validProof();
  assert.equal(validateAwsProof(proof, validationOptions('2026-10-16T12:01:10Z')).toctouFresh, true);
  assert.throws(
    () => validateAwsProof(proof, validationOptions('2026-10-16T12:06:06Z')),
    (error) => error?.code === 'TIMESTAMP_STALE'
  );
});

test('la plantilla versionada es ASCII, LF y byte-estable', () => {
  const bytes = readFileSync(join(here, '..', 'infra', 'cloudformation.yaml'));
  const result = validateCanonicalTemplateBytes(bytes);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(bytes.includes(0x0d), false);
  assert.equal(bytes.at(-1), 0x0a);
});

test('la validación de bytes rechaza BOM, CRLF, no ASCII y LF final ausente', () => {
  const cases = [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), templateBytes]),
    Buffer.from('Resources:\r\n', 'ascii'),
    Buffer.from('Descripción:\n', 'utf8'),
    Buffer.from('Resources:', 'ascii')
  ];
  for (const bytes of cases) assert.throws(() => validateCanonicalTemplateBytes(bytes));
});
