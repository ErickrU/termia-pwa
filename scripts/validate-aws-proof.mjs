#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  CONTRACT,
  ProofValidationError,
  buildShareableReport,
  computeChainDigest,
  createAttemptRecord,
  deriveDeploymentId,
  identitySha256,
  normalizeCloudTrailEvent,
  selectCloudTrailEvent,
  sha256,
  validateAwsProof,
  validateCanonicalTemplateBytes,
  validateCliSkeleton,
  validateShareableReport
} from './aws-proof.mjs';

function fail(code, message) {
  throw new ProofValidationError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message);
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    requireCondition(name?.startsWith('--') && value !== undefined, 'ARGUMENTS', 'Los argumentos deben ser pares --nombre valor.');
    requireCondition(!parsed.has(name), 'ARGUMENTS', `Argumento repetido: ${name}.`);
    parsed.set(name, value);
  }
  return parsed;
}

function required(args, name) {
  const value = args.get(name);
  requireCondition(typeof value === 'string' && value.length > 0, 'ARGUMENTS', `Falta ${name}.`);
  return value;
}

function readJson(path, code = 'JSON') {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code, `No se pudo leer JSON válido en ${basename(path)}.`);
  }
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

function requirePrivateDirectory(path) {
  const info = lstatSync(path);
  requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'PRIVATE_MODE', 'El directorio de evidencia no es regular.');
  requireCondition(fileMode(path) === 0o700, 'PRIVATE_MODE', 'El directorio de evidencia debe tener modo 0700.');
}

function requirePrivateFile(path) {
  const info = lstatSync(path);
  requireCondition(info.isFile() && !info.isSymbolicLink(), 'PRIVATE_MODE', `${basename(path)} no es un archivo regular.`);
  requireCondition(fileMode(path) === 0o600, 'PRIVATE_MODE', `${basename(path)} debe tener modo 0600.`);
}

function writeExclusive(path, value) {
  requireCondition(!existsSync(path), 'WRITE_ONCE', `${basename(path)} ya existe y no se sobrescribirá.`);
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, value);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  requirePrivateFile(path);
}

function writeExclusiveJson(path, value) {
  writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeIdentity(raw, attempt) {
  const accountId = raw.Account ?? raw.accountId;
  const principalArn = raw.Arn ?? raw.principalArn;
  const userId = raw.UserId ?? raw.userId;
  requireCondition(typeof accountId === 'string' && typeof principalArn === 'string' && typeof userId === 'string', 'IDENTITY', 'La respuesta STS está incompleta.');
  return { accountId, principalArn, userId, profile: attempt.profile, region: attempt.region };
}

function readCapture(attemptDirectory, prefix) {
  const metadataPath = join(attemptDirectory, `${prefix}.capture.json`);
  const stdoutPath = join(attemptDirectory, `${prefix}.stdout`);
  const stderrPath = join(attemptDirectory, `${prefix}.stderr`);
  for (const path of [metadataPath, stdoutPath, stderrPath]) requirePrivateFile(path);
  const metadata = readJson(metadataPath, 'CAPTURE');
  const stdout = readFileSync(stdoutPath);
  const stderr = readFileSync(stderrPath);
  requireCondition(metadata.stdoutSha256 === sha256(stdout) && metadata.stderrSha256 === sha256(stderr), 'CAPTURE_HASH', `Los hashes de ${prefix} no coinciden.`);
  return { ...metadata, stdout, stderr };
}

function readSuccessfulJsonCapture(attemptDirectory, prefix) {
  const capture = readCapture(attemptDirectory, prefix);
  requireCondition(capture.exitCode === 0, 'AWS_CAPTURE', `${prefix} no terminó correctamente.`);
  try {
    return { capture, document: JSON.parse(capture.stdout.toString('utf8')) };
  } catch {
    fail('AWS_CAPTURE', `${prefix} no produjo JSON válido.`);
  }
}

function extractAwsRequestId(stderr) {
  const text = stderr.toString('utf8');
  const patterns = [
    /["']x-amzn-requestid["']\s*:\s*["']([A-Za-z0-9-]{8,128})["']/gi,
    /<RequestId>([A-Za-z0-9-]{8,128})<\/RequestId>/gi,
    /\bRequestId\s*[:=]\s*["']?([A-Za-z0-9-]{8,128})["']?/gi
  ];
  const matches = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) matches.add(match[1]);
  }
  requireCondition(matches.size === 1, 'ABSENCE_REQUEST_ID', 'El probe DescribeStacks debe capturar un único request ID del servicio.');
  return [...matches][0];
}

function absenceRecord(attemptDirectory, prefix, operation, attempt, identity, identityHash) {
  const capture = readCapture(attemptDirectory, prefix);
  const stderr = capture.stderr.toString('utf8');
  requireCondition(capture.exitCode !== 0 && capture.stdout.toString('utf8').trim() === '', 'ABSENCE_SOURCE', `${operation} no falló de forma cerrada.`);
  requireCondition(/ValidationError/i.test(stderr) && /does not exist/i.test(stderr), 'ABSENCE_SOURCE', `${operation} no demostró ausencia.`);
  return {
    operation,
    stackName: CONTRACT.stackName,
    profile: attempt.profile,
    region: attempt.region,
    identitySha256: identityHash,
    absent: true,
    errorCode: 'ValidationError',
    exitCode: capture.exitCode,
    requestId: operation === 'DescribeStacks' ? extractAwsRequestId(capture.stderr) : null,
    requestedAt: capture.requestedAt,
    respondedAt: capture.respondedAt,
    stdoutSha256: capture.stdoutSha256,
    stderrSha256: capture.stderrSha256
  };
}

function stackTemplateAbsenceRecord(attemptDirectory, prefix, attempt, identityHash, stackId) {
  const capture = readCapture(attemptDirectory, prefix);
  const stderr = capture.stderr.toString('utf8');
  requireCondition(capture.exitCode !== 0 && capture.stdout.toString('utf8').trim() === '', 'STACK_TEMPLATE', 'GetTemplate del stack no falló de forma cerrada.');
  requireCondition(/ValidationError/i.test(stderr), 'STACK_TEMPLATE', 'GetTemplate del stack no demostró ausencia de template aplicado.');
  return {
    operation: 'GetTemplate',
    stackId,
    profile: attempt.profile,
    region: attempt.region,
    identitySha256: identityHash,
    absent: true,
    errorCode: 'ValidationError',
    exitCode: capture.exitCode,
    requestedAt: capture.requestedAt,
    respondedAt: capture.respondedAt,
    stdoutSha256: capture.stdoutSha256,
    stderrSha256: capture.stderrSha256
  };
}

function buildSnapshot(attemptDirectory, prefix, purpose, attempt, identity, identityHash, createResponse) {
  const names = [
    'describe-change-set',
    'list-change-sets',
    'describe-stacks',
    'list-stack-resources',
    'get-change-template'
  ];
  const captures = Object.fromEntries(names.map((name) => [name, readSuccessfulJsonCapture(attemptDirectory, `${prefix}-${name}`)]));
  const stackTemplate = stackTemplateAbsenceRecord(attemptDirectory, `${prefix}-get-stack-template`, attempt, identityHash, createResponse.StackId);
  const remoteBody = captures['get-change-template'].document.TemplateBody;
  requireCondition(typeof remoteBody === 'string', 'TEMPLATE_REMOTE', 'GetTemplate debe devolver TemplateBody como texto UTF-8 exacto.');
  const remoteBytes = Buffer.from(remoteBody, 'utf8');
  const startedAt = names.map((name) => Date.parse(captures[name].capture.requestedAt)).reduce((minimum, value) => Math.min(minimum, value));
  const observedAt = [
    ...names.map((name) => Date.parse(captures[name].capture.respondedAt)),
    Date.parse(stackTemplate.respondedAt)
  ].reduce((maximum, value) => Math.max(maximum, value));
  return {
    purpose,
    startedAt: new Date(startedAt).toISOString().replace(/\.000Z$/, 'Z'),
    observedAt: new Date(observedAt).toISOString().replace(/\.000Z$/, 'Z'),
    identity,
    describeChangeSet: captures['describe-change-set'].document,
    listChangeSets: captures['list-change-sets'].document,
    describeStacks: captures['describe-stacks'].document,
    listStackResources: captures['list-stack-resources'].document,
    stackTemplateAbsence: stackTemplate,
    remoteTemplateBodyBase64: remoteBytes.toString('base64'),
    remoteTemplateSha256: sha256(remoteBytes)
  };
}

function verifyChain(attemptDirectory, chainPath) {
  requirePrivateDirectory(attemptDirectory);
  requirePrivateFile(chainPath);
  const manifest = readJson(chainPath, 'EVIDENCE_CHAIN');
  requireCondition(manifest.version === 1 && Array.isArray(manifest.entries) && manifest.entries.length > 0, 'EVIDENCE_CHAIN', 'La cadena no tiene el formato esperado.');
  for (const entry of manifest.entries) {
    requireCondition(typeof entry.path === 'string' && basename(entry.path) === entry.path && !entry.path.startsWith('.'), 'EVIDENCE_CHAIN', 'La cadena contiene una ruta inválida.');
    const path = join(attemptDirectory, entry.path);
    requirePrivateFile(path);
    requireCondition(sha256(readFileSync(path)) === entry.sha256, 'EVIDENCE_CHAIN', `Cambió ${entry.path} después del sellado.`);
  }
  const calculated = computeChainDigest(manifest.entries, manifest.previousChainFileSha256 ?? null);
  requireCondition(calculated === manifest.chainSha256, 'EVIDENCE_CHAIN', 'El hash encadenado no coincide.');
  return manifest;
}

function ensurePathWithin(parent, candidate) {
  const resolvedParent = `${realpathSync(parent)}/`;
  const resolvedCandidate = resolve(candidate);
  requireCondition(`${dirname(resolvedCandidate)}/`.startsWith(resolvedParent), 'PATH_SCOPE', 'La salida debe permanecer dentro del intento.');
}

function commandInit(args) {
  const attemptsRoot = resolve(required(args, '--attempts-root'));
  const templatePath = resolve(required(args, '--template'));
  if (!existsSync(attemptsRoot)) mkdirSync(attemptsRoot, { mode: 0o700 });
  chmodSync(attemptsRoot, 0o700);
  requirePrivateDirectory(attemptsRoot);
  requireCondition(readdirSync(attemptsRoot).length === 0, 'ATTEMPT_EXISTS', 'Un intento anterior permanece preservado; no se inicia otro automáticamente.');
  const templateBytes = readFileSync(templatePath);
  const record = createAttemptRecord({
    profile: required(args, '--profile'),
    region: required(args, '--region'),
    commitSha: required(args, '--commit-sha'),
    confirmedCommitSha: required(args, '--confirm-commit-sha'),
    confirmedIdentitySha: required(args, '--confirm-identity-sha'),
    templateBytes,
    uuidFactory: randomUUID
  });
  const attemptDirectory = join(attemptsRoot, record.attemptId);
  mkdirSync(attemptDirectory, { mode: 0o700 });
  chmodSync(attemptDirectory, 0o700);
  writeExclusive(join(attemptDirectory, 'submitted-template.yaml'), templateBytes);
  writeExclusiveJson(join(attemptDirectory, 'attempt.json'), record);
  process.stdout.write(`${attemptDirectory}\n`);
}

function commandCaptureRecord(args) {
  const output = resolve(required(args, '--output'));
  const stdoutPath = resolve(required(args, '--stdout'));
  const stderrPath = resolve(required(args, '--stderr'));
  requirePrivateFile(stdoutPath);
  requirePrivateFile(stderrPath);
  const exitCode = Number(required(args, '--exit-code'));
  requireCondition(Number.isInteger(exitCode) && exitCode >= 0, 'CAPTURE', 'El exit code no es válido.');
  writeExclusiveJson(output, {
    requestedAt: required(args, '--requested-at'),
    respondedAt: required(args, '--responded-at'),
    exitCode,
    stdoutSha256: sha256(readFileSync(stdoutPath)),
    stderrSha256: sha256(readFileSync(stderrPath))
  });
}

function commandNormalizeIdentity(args) {
  const attempt = readJson(required(args, '--attempt'), 'ATTEMPT');
  const identity = normalizeIdentity(readJson(required(args, '--identity'), 'IDENTITY'), attempt);
  writeExclusiveJson(resolve(required(args, '--output')), identity);
}

function commandCreateRequest(args) {
  const attempt = readJson(required(args, '--attempt'), 'ATTEMPT');
  const identity = normalizeIdentity(readJson(required(args, '--identity'), 'IDENTITY'), attempt);
  const deploymentId = deriveDeploymentId(identity.accountId, attempt.region);
  const request = {
    operation: 'CreateChangeSet',
    requestedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    profile: attempt.profile,
    region: attempt.region,
    stackName: CONTRACT.stackName,
    changeSetName: attempt.changeSetName,
    changeSetType: 'CREATE',
    clientToken: attempt.clientToken,
    onStackFailure: 'DO_NOTHING',
    disableRollback: false,
    includeNestedStacks: false,
    importExistingResources: false,
    capabilities: [],
    notificationArns: [],
    roleArn: null,
    templateSha256: attempt.templateSha256,
    parameters: [
      { ParameterKey: 'ProjectSlug', ParameterValue: CONTRACT.project },
      { ParameterKey: 'Environment', ParameterValue: CONTRACT.environment },
      { ParameterKey: 'DeploymentId', ParameterValue: deploymentId },
      { ParameterKey: 'PriceClass', ParameterValue: CONTRACT.priceClass }
    ],
    tags: [
      { Key: 'Project', Value: CONTRACT.project },
      { Key: 'Environment', Value: CONTRACT.environment },
      { Key: 'ManagedBy', Value: 'CloudFormation' },
      { Key: 'Repository', Value: CONTRACT.repository },
      { Key: 'DeploymentId', Value: deploymentId }
    ]
  };
  writeExclusiveJson(resolve(required(args, '--output')), request);
}

function commandSelectCloudTrail(args) {
  const attempt = readJson(required(args, '--attempt'), 'ATTEMPT');
  const identity = normalizeIdentity(readJson(required(args, '--identity'), 'IDENTITY'), attempt);
  const lookup = readJson(required(args, '--input'), 'CLOUDTRAIL_EVENTS');
  requireCondition(Array.isArray(lookup.Events), 'CLOUDTRAIL_EVENTS', 'LookupEvents no devolvió Events.');
  const kind = required(args, '--kind');
  let expectedRequestId = null;
  if (kind === 'absence') {
    const attemptDirectory = resolve(required(args, '--attempt-dir'));
    requirePrivateDirectory(attemptDirectory);
    expectedRequestId = absenceRecord(
      attemptDirectory,
      required(args, '--probe-prefix'),
      'DescribeStacks',
      attempt,
      identity,
      identitySha256(identity)
    ).requestId;
  }
  const selected = selectCloudTrailEvent(lookup.Events, {
    kind,
    context: attempt,
    identity,
    expectedRequestId
  });
  writeExclusiveJson(resolve(required(args, '--output')), selected);
}

function commandSeal(args) {
  const attemptDirectory = resolve(required(args, '--attempt-dir'));
  requirePrivateDirectory(attemptDirectory);
  const outputName = required(args, '--output-name');
  requireCondition(basename(outputName) === outputName && !outputName.startsWith('.'), 'PATH_SCOPE', 'El nombre del sello no es válido.');
  const output = join(attemptDirectory, outputName);
  requireCondition(!existsSync(output), 'WRITE_ONCE', 'El sello ya existe.');
  let previousChainFileSha256 = null;
  if (args.has('--previous')) {
    const previous = resolve(required(args, '--previous'));
    requirePrivateFile(previous);
    previousChainFileSha256 = sha256(readFileSync(previous));
  }
  const entries = readdirSync(attemptDirectory).sort().filter((name) => name !== outputName).map((name) => {
    requireCondition(basename(name) === name && !name.startsWith('.'), 'EVIDENCE_CHAIN', 'El intento contiene una ruta no permitida.');
    const path = join(attemptDirectory, name);
    requirePrivateFile(path);
    return { path: name, sha256: sha256(readFileSync(path)) };
  });
  const manifest = {
    version: 1,
    previousChainFileSha256,
    entries,
    chainSha256: computeChainDigest(entries, previousChainFileSha256)
  };
  writeExclusiveJson(output, manifest);
}

function commandBuild(args) {
  const phase = required(args, '--phase');
  requireCondition(phase === 'prepare' || phase === 'execute', 'PHASE', 'La fase de build no es válida.');
  const attemptDirectory = resolve(required(args, '--attempt-dir'));
  requirePrivateDirectory(attemptDirectory);
  const attempt = readJson(join(attemptDirectory, 'attempt.json'), 'ATTEMPT');
  const identity = normalizeIdentity(readJson(join(attemptDirectory, 'identity.json'), 'IDENTITY'), attempt);
  const identityHash = identitySha256(identity);
  requireCondition(identityHash === attempt.confirmedIdentitySha, 'IDENTITY_CONFIRMATION', 'La identidad no coincide con la confirmación aprobada.');
  const submittedTemplate = readFileSync(join(attemptDirectory, 'submitted-template.yaml'));
  const commitTemplate = readFileSync(join(attemptDirectory, 'commit-template.yaml'));
  validateCanonicalTemplateBytes(submittedTemplate);
  requireCondition(submittedTemplate.equals(commitTemplate), 'TEMPLATE_COMMIT_MISMATCH', 'La plantilla no coincide con el commit.');
  const createRequest = readJson(join(attemptDirectory, 'create-request.json'), 'CREATE_REQUEST');
  const createCapture = readSuccessfulJsonCapture(attemptDirectory, 'create-change-set');
  const createResponse = createCapture.document;
  requireCondition(typeof createResponse.Id === 'string' && typeof createResponse.StackId === 'string', 'CREATE_RESPONSE', 'CreateChangeSet no devolvió IDs.');
  const absenceTrail = normalizeCloudTrailEvent(readJson(join(attemptDirectory, 'cloudtrail-describe-event.json'), 'CLOUDTRAIL_EVENT'));
  const createTrail = normalizeCloudTrailEvent(readJson(join(attemptDirectory, 'cloudtrail-create-event.json'), 'CLOUDTRAIL_EVENT'));
  const inputChainPath = resolve(required(args, '--input-chain'));
  verifyChain(attemptDirectory, inputChainPath);
  const context = {
    ...attempt,
    identitySha256: identityHash,
    deploymentId: deriveDeploymentId(identity.accountId, attempt.region)
  };
  const proof = {
    schemaVersion: CONTRACT.schemaVersion,
    phase,
    context,
    integrity: { inputChainSha256: sha256(readFileSync(inputChainPath)) },
    template: {
      localBodyBase64: submittedTemplate.toString('base64'),
      commitBodyBase64: commitTemplate.toString('base64'),
      localSha256: sha256(submittedTemplate),
      commitSha256: sha256(commitTemplate),
      byteLength: submittedTemplate.length
    },
    identity,
    preflight: {
      describeStacks: absenceRecord(attemptDirectory, 'preflight-describe-stacks', 'DescribeStacks', attempt, identity, identityHash),
      listChangeSets: absenceRecord(attemptDirectory, 'preflight-list-change-sets', 'ListChangeSets', attempt, identity, identityHash),
      cloudTrailDescribeStacks: { ...absenceTrail, stackName: absenceTrail.requestParameters.stackName }
    },
    create: {
      request: createRequest,
      response: {
        changeSetId: createResponse.Id,
        stackId: createResponse.StackId,
        requestedAt: createCapture.capture.requestedAt,
        respondedAt: createCapture.capture.respondedAt,
        stdoutSha256: createCapture.capture.stdoutSha256,
        stderrSha256: createCapture.capture.stderrSha256
      },
      cloudTrailCreateChangeSet: createTrail
    },
    snapshots: {
      prepare: buildSnapshot(attemptDirectory, 'prepare', 'prepare-review', attempt, identity, identityHash, createResponse)
    }
  };
  if (phase === 'execute') {
    const toctouIdentity = normalizeIdentity(readJson(join(attemptDirectory, 'toctou-identity.stdout'), 'IDENTITY'), attempt);
    requireCondition(identitySha256(toctouIdentity) === identityHash, 'SNAPSHOT_IDENTITY', 'La identidad cambió antes de execute.');
    proof.snapshots.toctou = buildSnapshot(attemptDirectory, 'toctou', 'before-execute', attempt, toctouIdentity, identityHash, createResponse);
  }
  writeExclusiveJson(resolve(required(args, '--output')), proof);
}

function validateEvidence(args, now = new Date()) {
  const evidencePath = resolve(required(args, '--evidence'));
  const chainPath = resolve(required(args, '--chain'));
  const attemptDirectory = dirname(evidencePath);
  verifyChain(attemptDirectory, chainPath);
  const evidence = readJson(evidencePath, 'EVIDENCE');
  const summary = validateAwsProof(evidence, {
    phase: required(args, '--phase'),
    templateBytes: readFileSync(required(args, '--template')),
    commitTemplateBytes: readFileSync(required(args, '--commit-template')),
    expectedCommitSha: required(args, '--expected-commit-sha'),
    expectedIdentitySha: required(args, '--expected-identity-sha'),
    inputChainSha256: sha256(readFileSync(chainPath)),
    now
  });
  return { evidence, evidencePath, chainPath, summary };
}

function commandValidate(args) {
  const now = args.has('--now') ? required(args, '--now') : new Date();
  const { summary } = validateEvidence(args, now);
  if (args.has('--summary-output')) writeExclusiveJson(resolve(required(args, '--summary-output')), summary);
  process.stdout.write('AWS proof: PASS\n');
}

function commandGuardExecute(args) {
  requireCondition(required(args, '--phase') === 'execute', 'PHASE', 'El guard final solo admite execute.');
  const requestedAt = required(args, '--requested-at');
  requireCondition(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(requestedAt) && Number.isFinite(Date.parse(requestedAt)), 'EXECUTE_TIME', 'El inicio de execute debe ser UTC.');
  const { evidence, evidencePath, chainPath, summary } = validateEvidence(args, requestedAt);
  writeExclusiveJson(resolve(required(args, '--output')), {
    requestedAt,
    toctouObservedAt: evidence.snapshots.toctou.observedAt,
    evidenceSha256: sha256(readFileSync(evidencePath)),
    chainSha256: sha256(readFileSync(chainPath)),
    checks: summary
  });
}

function commandVerifyExecuteCapture(args) {
  const guardPath = resolve(required(args, '--guard'));
  const capturePath = resolve(required(args, '--capture'));
  const evidencePath = resolve(required(args, '--evidence'));
  requirePrivateFile(guardPath);
  requirePrivateFile(capturePath);
  requirePrivateFile(evidencePath);
  const guard = readJson(guardPath, 'EXECUTE_GUARD');
  const capture = readJson(capturePath, 'EXECUTE_CAPTURE');
  requireCondition(guard.requestedAt === capture.requestedAt, 'EXECUTE_CORRELATION', 'El guard final no corresponde al inicio capturado de execute-change-set.');
  requireCondition(guard.evidenceSha256 === sha256(readFileSync(evidencePath)), 'EXECUTE_CORRELATION', 'La evidencia validada por el guard final cambió.');
  requireCondition(Date.parse(capture.requestedAt) <= Date.parse(capture.respondedAt), 'EXECUTE_CORRELATION', 'La captura de execute-change-set tiene un intervalo inválido.');
}

function commandReport(args) {
  const evidencePath = resolve(required(args, '--evidence'));
  const chainPath = resolve(required(args, '--chain'));
  const evidence = readJson(evidencePath, 'EVIDENCE');
  const summary = readJson(required(args, '--summary'), 'REPORT');
  const report = buildShareableReport({
    evidenceBytes: readFileSync(evidencePath),
    chainBytes: readFileSync(chainPath),
    proofSummary: summary,
    templateSha256: evidence.template.localSha256,
    commitSha: evidence.context.commitSha,
    identityHash: evidence.context.identitySha256
  });
  validateShareableReport(report);
  writeExclusiveJson(resolve(required(args, '--output')), report);
}

function commandPointer(args) {
  const evidence = readJson(required(args, '--evidence'), 'EVIDENCE');
  const attemptDirectory = resolve(required(args, '--attempt-dir'));
  requirePrivateDirectory(attemptDirectory);
  writeExclusiveJson(resolve(required(args, '--output')), {
    attemptDirectory,
    attemptId: evidence.context.attemptId,
    stackName: evidence.context.stackName,
    stackId: evidence.create.response.stackId,
    changeSetName: evidence.context.changeSetName,
    changeSetId: evidence.create.response.changeSetId,
    clientToken: evidence.context.clientToken,
    profile: evidence.context.profile,
    region: evidence.context.region,
    commitSha: evidence.context.commitSha,
    identitySha256: evidence.context.identitySha256,
    templateSha256: evidence.template.localSha256,
    prepareEvidenceSha256: sha256(readFileSync(required(args, '--evidence')))
  });
}

function commandCheckPermissions(args) {
  const attemptDirectory = resolve(required(args, '--attempt-dir'));
  requirePrivateDirectory(attemptDirectory);
  for (const name of readdirSync(attemptDirectory)) requirePrivateFile(join(attemptDirectory, name));
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArguments(rest);

try {
  switch (command) {
    case 'check-template':
      validateCanonicalTemplateBytes(readFileSync(required(args, '--template')));
      process.stdout.write('Template bytes: PASS\n');
      break;
    case 'check-skeleton':
      validateCliSkeleton(readJson(required(args, '--skeleton'), 'CLI_SKELETON'));
      process.stdout.write('AWS CLI skeleton: PASS\n');
      break;
    case 'identity-hash': {
      const attempt = readJson(required(args, '--attempt'), 'ATTEMPT');
      const identity = normalizeIdentity(readJson(required(args, '--identity'), 'IDENTITY'), attempt);
      process.stdout.write(`${identitySha256(identity)}\n`);
      break;
    }
    case 'init-attempt': commandInit(args); break;
    case 'capture-record': commandCaptureRecord(args); break;
    case 'normalize-identity': commandNormalizeIdentity(args); break;
    case 'create-request': commandCreateRequest(args); break;
    case 'select-cloudtrail': commandSelectCloudTrail(args); break;
    case 'seal': commandSeal(args); break;
    case 'verify-chain':
      verifyChain(resolve(required(args, '--attempt-dir')), resolve(required(args, '--chain')));
      process.stdout.write('Evidence chain: PASS\n');
      break;
    case 'build': commandBuild(args); break;
    case 'validate': commandValidate(args); break;
    case 'guard-execute': commandGuardExecute(args); break;
    case 'verify-execute-capture': commandVerifyExecuteCapture(args); break;
    case 'report': commandReport(args); break;
    case 'pointer': commandPointer(args); break;
    case 'check-permissions': commandCheckPermissions(args); break;
    case 'check-absence': {
      const attempt = readJson(required(args, '--attempt'), 'ATTEMPT');
      const identity = normalizeIdentity(readJson(required(args, '--identity'), 'IDENTITY'), attempt);
      const hash = identitySha256(identity);
      absenceRecord(required(args, '--attempt-dir'), required(args, '--prefix'), required(args, '--operation'), attempt, identity, hash);
      process.stdout.write('Absence probe: PASS\n');
      break;
    }
    default:
      fail('ARGUMENTS', 'Comando no reconocido.');
  }
} catch (error) {
  if (error instanceof ProofValidationError) {
    process.stderr.write(`ERROR [${error.code}]: ${error.message}\n`);
    process.exitCode = error.code === 'CLOUDTRAIL_NOT_FOUND' ? 3 : error.code === 'CLOUDTRAIL_AMBIGUOUS' ? 2 : 1;
  } else {
    process.stderr.write('ERROR [INTERNAL]: el validador local no pudo completar la operación.\n');
    process.exitCode = 1;
  }
}
