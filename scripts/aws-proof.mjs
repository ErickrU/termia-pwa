import { createHash } from 'node:crypto';

const stackName = process.env.AWS_STACK_NAME;
if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName ?? '')) {
  throw new Error('AWS_STACK_NAME debe contener un nombre de stack explícito y válido.');
}

export const CONTRACT = Object.freeze({
  schemaVersion: 1,
  project: 'termia-pwa',
  repository: 'ErickrU-termia-pwa',
  stackName,
  environment: 'prod',
  priceClass: 'PriceClass_100',
  maxFreshnessMs: 300_000,
  maxPreflightGapMs: 60_000,
  logicalResources: Object.freeze({
    ContentBucket: 'AWS::S3::Bucket',
    ContentBucketPolicy: 'AWS::S3::BucketPolicy',
    Distribution: 'AWS::CloudFront::Distribution',
    OriginAccessControl: 'AWS::CloudFront::OriginAccessControl',
    SecurityHeadersPolicy: 'AWS::CloudFront::ResponseHeadersPolicy'
  })
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const PROFILE_PATTERN = /^[A-Za-z0-9_+=,.@-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][-A-Za-z0-9]{0,127}$/;

export class ProofValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProofValidationError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new ProofValidationError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) reject(code, message);
}

function requireObject(value, code, label) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), code, `${label} debe ser un objeto.`);
  return value;
}

function requireString(value, code, label) {
  requireCondition(typeof value === 'string' && value.length > 0, code, `${label} debe ser texto no vacío.`);
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseUtc(value, code, label) {
  requireCondition(typeof value === 'string' && UTC_PATTERN.test(value), code, `${label} debe ser UTC ISO-8601.`);
  const timestamp = Date.parse(value);
  requireCondition(Number.isFinite(timestamp), code, `${label} no es una fecha válida.`);
  return timestamp;
}

function requireSha(value, code, label) {
  requireCondition(typeof value === 'string' && SHA256_PATTERN.test(value), code, `${label} debe ser SHA-256.`);
  return value;
}

function strictBase64(value, code, label) {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length % 4 === 0, code, `${label} no es base64 canónico.`);
  requireCondition(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), code, `${label} no es base64 canónico.`);
  const bytes = Buffer.from(value, 'base64');
  requireCondition(bytes.toString('base64') === value, code, `${label} no es base64 canónico.`);
  return bytes;
}

export function validateCanonicalTemplateBytes(bytes) {
  requireCondition(Buffer.isBuffer(bytes), 'TEMPLATE_BYTES', 'La plantilla debe validarse como bytes crudos.');
  requireCondition(bytes.length > 0, 'TEMPLATE_EMPTY', 'La plantilla no puede estar vacía.');
  requireCondition(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'TEMPLATE_BOM', 'La plantilla no puede incluir BOM UTF-8.');
  requireCondition(!bytes.includes(0x0d), 'TEMPLATE_CR', 'La plantilla debe usar únicamente LF.');
  requireCondition(bytes[bytes.length - 1] === 0x0a, 'TEMPLATE_FINAL_LF', 'La plantilla debe terminar en LF.');
  for (const byte of bytes) {
    requireCondition(byte <= 0x7f, 'TEMPLATE_NON_ASCII', 'La plantilla debe ser ASCII byte-estable.');
  }
  return { sha256: sha256(bytes), byteLength: bytes.length };
}

export function validateCliSkeleton(skeleton) {
  requireObject(skeleton, 'CLI_SKELETON', 'El skeleton de create-change-set');
  for (const field of ['StackName', 'ChangeSetName', 'ChangeSetType', 'ClientToken', 'OnStackFailure']) {
    requireCondition(hasOwn(skeleton, field), 'CLI_SKELETON', `AWS CLI v2 no declara ${field}.`);
  }
  return true;
}

export function createAttemptRecord({ profile, region, commitSha, confirmedCommitSha, confirmedIdentitySha, templateBytes, now = new Date(), uuidFactory }) {
  requireCondition(PROFILE_PATTERN.test(profile), 'PROFILE', 'El profile explícito no es válido.');
  requireCondition(REGION_PATTERN.test(region), 'REGION', 'La región explícita no es válida.');
  requireCondition(COMMIT_PATTERN.test(commitSha), 'COMMIT_SHA', 'El commit actual no es válido.');
  requireCondition(confirmedCommitSha === commitSha, 'COMMIT_CONFIRMATION', 'La confirmación del commit no coincide.');
  requireSha(confirmedIdentitySha, 'IDENTITY_CONFIRMATION', 'La confirmación de identidad');
  const template = validateCanonicalTemplateBytes(templateBytes);
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const attemptId = uuidFactory();
  const tokenUuid = uuidFactory();
  requireCondition(UUID_PATTERN.test(attemptId) && UUID_PATTERN.test(tokenUuid), 'ATTEMPT_ID', 'El generador no devolvió UUID válidos.');
  const compactTime = createdAt.replace(/[-:]/g, '').replace('Z', 'Z');
  const nonce = attemptId.replaceAll('-', '').slice(0, 12).toLowerCase();
  return {
    schemaVersion: CONTRACT.schemaVersion,
    attemptId: attemptId.toLowerCase(),
    createdAt,
    project: CONTRACT.project,
    repository: CONTRACT.repository,
    stackName: CONTRACT.stackName,
    environment: CONTRACT.environment,
    priceClass: CONTRACT.priceClass,
    profile,
    region,
    commitSha,
    confirmedCommitSha,
    confirmedIdentitySha,
    templateSha256: template.sha256,
    templateByteLength: template.byteLength,
    changeSetName: `${CONTRACT.project}-create-${compactTime}-${nonce}`,
    clientToken: `${CONTRACT.project}-${tokenUuid.toLowerCase()}`,
    gitClean: true
  };
}

export function identitySha256(identity) {
  const value = requireObject(identity, 'IDENTITY', 'La identidad');
  return sha256(canonicalJson({
    accountId: value.accountId,
    principalArn: value.principalArn,
    profile: value.profile,
    region: value.region
  }));
}

export function deriveDeploymentId(accountId, region, stackName = CONTRACT.stackName) {
  return sha256(`${accountId}:${region}:${stackName}`).slice(0, 10);
}

function validateIdentity(identity, context, expectedHash, code = 'IDENTITY') {
  const value = requireObject(identity, code, 'La identidad');
  requireCondition(/^\d{12}$/.test(value.accountId), code, 'La cuenta debe tener doce dígitos.');
  requireString(value.principalArn, code, 'El principal');
  requireCondition(value.principalArn.includes(`::${value.accountId}:`), code, 'El principal no pertenece a la cuenta registrada.');
  requireCondition(/^arn:(?:aws|aws-cn|aws-us-gov):(?:iam|sts)::/.test(value.principalArn), code, 'El principal no es un ARN IAM/STS esperado.');
  requireCondition(value.profile === context.profile && value.region === context.region, code, 'Profile o región discordantes.');
  requireCondition(identitySha256(value) === expectedHash, 'IDENTITY_HASH', 'El hash canónico de identidad no coincide.');
  return value;
}

function sortedCanonical(array) {
  return array.map((item) => canonicalJson(item)).sort();
}

function normalizedParameters(array) {
  requireCondition(Array.isArray(array), 'PARAMETERS', 'Los parámetros deben ser una lista.');
  return array.map((item) => ({
    ParameterKey: item.ParameterKey ?? item.parameterKey,
    ParameterValue: item.ParameterValue ?? item.parameterValue
  }));
}

function normalizedTags(array) {
  requireCondition(Array.isArray(array), 'TAGS', 'Los tags deben ser una lista.');
  return array.map((item) => ({ Key: item.Key ?? item.key, Value: item.Value ?? item.value }));
}

function expectedParameters(deploymentId) {
  return [
    { ParameterKey: 'DeploymentId', ParameterValue: deploymentId },
    { ParameterKey: 'Environment', ParameterValue: CONTRACT.environment },
    { ParameterKey: 'PriceClass', ParameterValue: CONTRACT.priceClass },
    { ParameterKey: 'ProjectSlug', ParameterValue: CONTRACT.project }
  ];
}

function expectedTags(deploymentId) {
  return [
    { Key: 'DeploymentId', Value: deploymentId },
    { Key: 'Environment', Value: CONTRACT.environment },
    { Key: 'ManagedBy', Value: 'CloudFormation' },
    { Key: 'Project', Value: CONTRACT.project },
    { Key: 'Repository', Value: CONTRACT.repository }
  ];
}

function requireExactCollection(actual, expected, code, label) {
  requireCondition(canonicalJson(sortedCanonical(actual)) === canonicalJson(sortedCanonical(expected)), code, `${label} no coincide con el contrato exacto.`);
}

function expectedDescription(templateSha) {
  return `Termia template ${templateSha}`;
}

function requireOptionalEmptyArray(value, code, label) {
  requireCondition(value === undefined || value === null || (Array.isArray(value) && value.length === 0), code, `${label} debe estar ausente o vacío.`);
}

function requireOptionalEmptyObject(value, code, label) {
  requireCondition(value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0), code, `${label} debe estar ausente o vacío.`);
}

function requireOptionalAbsentString(value, code, label) {
  requireCondition(value === undefined || value === null || value === '', code, `${label} debe estar ausente.`);
}

function requireOptionalFalse(value, code, label) {
  requireCondition(value === undefined || value === null || value === false, code, `${label} debe estar ausente o ser false.`);
}

function requireEmptyRollbackConfiguration(value, code, label) {
  if (value === undefined || value === null) return;
  const configuration = requireObject(value, code, label);
  const allowedKeys = new Set(['RollbackTriggers', 'rollbackTriggers', 'MonitoringTimeInMinutes', 'monitoringTimeInMinutes']);
  requireCondition(Object.keys(configuration).every((key) => allowedKeys.has(key)), code, `${label} contiene campos inesperados.`);
  requireCondition(!(hasOwn(configuration, 'RollbackTriggers') && hasOwn(configuration, 'rollbackTriggers')), code, `${label} duplica rollback triggers.`);
  requireCondition(!(hasOwn(configuration, 'MonitoringTimeInMinutes') && hasOwn(configuration, 'monitoringTimeInMinutes')), code, `${label} duplica monitoring time.`);
  const triggers = configuration.RollbackTriggers ?? configuration.rollbackTriggers ?? [];
  const monitoring = configuration.MonitoringTimeInMinutes ?? configuration.monitoringTimeInMinutes ?? 0;
  requireCondition(Array.isArray(triggers) && triggers.length === 0 && monitoring === 0, code, `${label} debe estar vacío.`);
}

function validateTemplateEvidence(template, templateBytes, commitTemplateBytes) {
  const value = requireObject(template, 'TEMPLATE_EVIDENCE', 'La evidencia de plantilla');
  const local = strictBase64(value.localBodyBase64, 'TEMPLATE_EVIDENCE', 'localBodyBase64');
  const commit = strictBase64(value.commitBodyBase64, 'TEMPLATE_EVIDENCE', 'commitBodyBase64');
  requireCondition(local.equals(templateBytes), 'TEMPLATE_LOCAL_MISMATCH', 'Los bytes locales no coinciden con la evidencia.');
  requireCondition(commit.equals(commitTemplateBytes), 'TEMPLATE_COMMIT_MISMATCH', 'Los bytes del commit no coinciden con la evidencia.');
  requireCondition(local.equals(commit), 'TEMPLATE_COMMIT_MISMATCH', 'La plantilla local difiere del commit aprobado.');
  const canonical = validateCanonicalTemplateBytes(local);
  requireCondition(value.localSha256 === canonical.sha256 && value.commitSha256 === canonical.sha256, 'TEMPLATE_HASH', 'Los hashes local/commit no coinciden.');
  requireCondition(value.byteLength === canonical.byteLength, 'TEMPLATE_HASH', 'La longitud registrada no coincide.');
  return canonical;
}

function validateCapture(capture, expectedOperation, context, identityHash, code) {
  const value = requireObject(capture, code, expectedOperation);
  requireCondition(value.operation === expectedOperation, code, `La operación debe ser ${expectedOperation}.`);
  requireCondition(value.stackName === CONTRACT.stackName, code, 'El nombre del stack no coincide.');
  requireCondition(value.profile === context.profile && value.region === context.region, code, 'Profile o región del probe no coinciden.');
  requireCondition(value.identitySha256 === identityHash, code, 'La identidad del probe no coincide.');
  requireCondition(value.absent === true && Number.isInteger(value.exitCode) && value.exitCode !== 0, code, 'El probe no demostró ausencia fail-closed.');
  requireCondition(value.errorCode === 'ValidationError', code, 'El probe no devolvió ValidationError de ausencia.');
  const requestedAt = parseUtc(value.requestedAt, code, `${expectedOperation}.requestedAt`);
  const respondedAt = parseUtc(value.respondedAt, code, `${expectedOperation}.respondedAt`);
  requireCondition(requestedAt <= respondedAt, code, 'El intervalo del probe es inválido.');
  requireSha(value.stdoutSha256, code, 'El hash de stdout');
  requireSha(value.stderrSha256, code, 'El hash de stderr');
  const requestId = expectedOperation === 'DescribeStacks'
    ? requireString(value.requestId, code, 'DescribeStacks requestId')
    : value.requestId ?? null;
  return { requestedAt, respondedAt, requestId };
}

function validateCloudTrailIdentity(event, identity, context, code) {
  requireCondition(event.awsRegion === context.region, code, 'La región CloudTrail no coincide.');
  requireCondition(event.recipientAccountId === identity.accountId, code, 'La cuenta CloudTrail no coincide.');
  requireCondition(event.principalArn === identity.principalArn, code, 'El principal CloudTrail no coincide.');
  requireString(event.requestId, code, 'CloudTrail requestId');
  requireString(event.eventId, code, 'CloudTrail eventId');
  return parseUtc(event.eventTime, code, 'CloudTrail eventTime');
}

function validatePreflight(preflight, context, identity, identityHash, createCaptureRequestedAt) {
  const value = requireObject(preflight, 'PREFLIGHT', 'El preflight');
  requireCondition(hasOwn(value, 'describeStacks') && hasOwn(value, 'listChangeSets'), 'ABSENCE_SOURCE', 'Falta una de las dos fuentes locales de ausencia.');
  const describe = validateCapture(value.describeStacks, 'DescribeStacks', context, identityHash, 'ABSENCE_DESCRIBE');
  const list = validateCapture(value.listChangeSets, 'ListChangeSets', context, identityHash, 'ABSENCE_LIST');
  for (const result of [describe, list]) {
    requireCondition(result.respondedAt <= createCaptureRequestedAt, 'ABSENCE_ORDER', 'Los probes deben terminar antes de la captura real de CreateChangeSet.');
    requireCondition(createCaptureRequestedAt - result.respondedAt <= CONTRACT.maxPreflightGapMs, 'ABSENCE_ORDER', 'Los probes no son inmediatamente anteriores a la captura real de CreateChangeSet.');
  }

  const trail = requireObject(value.cloudTrailDescribeStacks, 'ABSENCE_CLOUDTRAIL', 'El evento DescribeStacks');
  requireCondition(trail.eventName === 'DescribeStacks', 'ABSENCE_CLOUDTRAIL', 'El evento CloudTrail no es DescribeStacks.');
  requireCondition(trail.stackName === CONTRACT.stackName, 'ABSENCE_CLOUDTRAIL', 'CloudTrail consultó otro stack.');
  requireCondition(trail.errorCode === 'ValidationError', 'ABSENCE_CLOUDTRAIL', 'CloudTrail no demuestra ausencia.');
  const eventTime = validateCloudTrailIdentity(trail, identity, context, 'ABSENCE_CLOUDTRAIL');
  requireCondition(trail.requestId === describe.requestId, 'ABSENCE_CLOUDTRAIL', 'CloudTrail no corresponde al request ID exacto del probe DescribeStacks.');
  requireCondition(eventTime >= describe.requestedAt - 5_000 && eventTime <= describe.respondedAt + 5_000, 'ABSENCE_CLOUDTRAIL', 'El evento no correlaciona temporalmente con el probe.');
}

function validateRequest(request, context, deploymentId, templateSha, clientToken, changeSetName) {
  const value = requireObject(request, 'CREATE_REQUEST', 'El request CreateChangeSet');
  requireCondition(value.operation === 'CreateChangeSet', 'CREATE_REQUEST', 'La operación no es CreateChangeSet.');
  requireCondition(value.stackName === CONTRACT.stackName && value.changeSetName === changeSetName, 'CREATE_REQUEST', 'Stack o change set discordante.');
  requireCondition(value.changeSetType === 'CREATE', 'CREATE_TYPE', 'El request debe fijar CREATE.');
  requireCondition(value.clientToken === clientToken && TOKEN_PATTERN.test(value.clientToken), 'CLIENT_TOKEN', 'El client token debe ser interno, no vacío y estable.');
  requireCondition(value.description === expectedDescription(templateSha), 'CREATE_REQUEST', 'La descripción no está ligada al hash exacto de la plantilla.');
  requireCondition(value.onStackFailure === 'DO_NOTHING', 'ON_STACK_FAILURE', 'OnStackFailure debe ser DO_NOTHING.');
  requireCondition(value.disableRollback === false, 'DISABLE_ROLLBACK', 'DisableRollback debe permanecer falso y no combinarse con OnStackFailure.');
  requireCondition(value.includeNestedStacks === false && value.importExistingResources === false, 'CREATE_SCOPE', 'Nested stacks o imports no están permitidos.');
  requireCondition(Array.isArray(value.capabilities) && value.capabilities.length === 0, 'CAPABILITIES', 'No se permiten capabilities.');
  requireCondition(Array.isArray(value.notificationArns) && value.notificationArns.length === 0 && value.roleArn === null, 'CREATE_SCOPE', 'No se permiten roles ni notificaciones.');
  requireCondition(Array.isArray(value.resourceTypes) && value.resourceTypes.length === 0, 'CREATE_SCOPE', 'No se permite restringir o ampliar el request mediante resource types.');
  requireCondition(Array.isArray(value.resourcesToImport) && value.resourcesToImport.length === 0, 'CREATE_SCOPE', 'No se permiten recursos para importar.');
  requireCondition(value.rollbackConfiguration === null && value.templateUrl === null, 'CREATE_SCOPE', 'No se permiten rollback triggers ni template URL.');
  requireCondition(value.templateSha256 === templateSha, 'TEMPLATE_HASH', 'El request registra otro hash de plantilla.');
  requireCondition(value.profile === context.profile && value.region === context.region, 'CREATE_REQUEST', 'Profile o región del request no coinciden.');
  requireExactCollection(normalizedParameters(value.parameters), expectedParameters(deploymentId), 'PARAMETERS', 'Los parámetros');
  requireExactCollection(normalizedTags(value.tags), expectedTags(deploymentId), 'TAGS', 'Los tags');
  return parseUtc(value.requestedAt, 'CREATE_REQUEST', 'CreateChangeSet.requestedAt');
}

function validateCreate(create, context, identity, reviewedRequestTime, deploymentId, templateSha, clientToken, changeSetName) {
  const value = requireObject(create, 'CREATE', 'La evidencia de creación');
  const request = value.request;
  const parsedRequestTime = validateRequest(request, context, deploymentId, templateSha, clientToken, changeSetName);
  requireCondition(parsedRequestTime === reviewedRequestTime, 'CREATE_REQUEST', 'El timestamp del request revisado no coincide.');
  const response = requireObject(value.response, 'CREATE_RESPONSE', 'La respuesta CreateChangeSet');
  requireString(response.changeSetId, 'CREATE_RESPONSE', 'changeSetId');
  requireString(response.stackId, 'CREATE_RESPONSE', 'stackId');
  requireCondition(response.changeSetId.includes(changeSetName), 'CREATE_RESPONSE', 'El ID no pertenece al change set generado.');
  requireCondition(response.stackId.includes(CONTRACT.stackName), 'CREATE_RESPONSE', 'El ID no pertenece al stack fijado.');
  const requestedAt = parseUtc(response.requestedAt, 'CREATE_RESPONSE', 'CreateChangeSet.capture.requestedAt');
  const respondedAt = parseUtc(response.respondedAt, 'CREATE_RESPONSE', 'CreateChangeSet.capture.respondedAt');
  requireCondition(reviewedRequestTime <= requestedAt, 'CREATE_REQUEST', 'La captura real de CreateChangeSet precede al request revisado.');
  requireCondition(requestedAt - reviewedRequestTime <= CONTRACT.maxPreflightGapMs, 'CREATE_REQUEST', 'El request revisado quedó obsoleto antes de la captura real.');
  requireCondition(requestedAt <= respondedAt, 'CREATE_RESPONSE', 'La respuesta precede al inicio real de la captura.');
  requireSha(response.stdoutSha256, 'CREATE_RESPONSE', 'El hash de la respuesta');
  requireSha(response.stderrSha256, 'CREATE_RESPONSE', 'El hash del error');

  const trail = requireObject(value.cloudTrailCreateChangeSet, 'CREATE_CLOUDTRAIL', 'El evento CreateChangeSet');
  requireCondition(trail.eventName === 'CreateChangeSet' && (trail.errorCode === null || trail.errorCode === undefined), 'CREATE_CLOUDTRAIL', 'CloudTrail no registra un CreateChangeSet exitoso.');
  const eventTime = validateCloudTrailIdentity(trail, identity, context, 'CREATE_CLOUDTRAIL');
  requireCondition(eventTime >= requestedAt - 5_000 && eventTime <= respondedAt + 5_000, 'CREATE_CLOUDTRAIL', 'El evento CreateChangeSet no correlaciona con la captura real.');
  const eventRequest = requireObject(trail.requestParameters, 'CREATE_CLOUDTRAIL', 'requestParameters');
  requireCondition(eventRequest.stackName === CONTRACT.stackName && eventRequest.changeSetName === changeSetName, 'CREATE_CLOUDTRAIL', 'CloudTrail registra otros nombres.');
  requireCondition(eventRequest.clientToken === clientToken, 'CLIENT_TOKEN', 'CloudTrail no conserva el client token exacto.');
  if (eventRequest.changeSetType !== undefined && eventRequest.changeSetType !== null) {
    requireCondition(eventRequest.changeSetType === 'CREATE', 'CREATE_TYPE', 'CloudTrail contradice el request CREATE.');
  }
  if (eventRequest.description !== undefined && eventRequest.description !== null) {
    requireCondition(eventRequest.description === expectedDescription(templateSha), 'CREATE_CLOUDTRAIL', 'CloudTrail contradice la descripción revisada.');
  }
  if (eventRequest.onStackFailure !== undefined && eventRequest.onStackFailure !== null) {
    requireCondition(eventRequest.onStackFailure === 'DO_NOTHING', 'ON_STACK_FAILURE', 'CloudTrail contradice DO_NOTHING.');
  }
  requireOptionalFalse(eventRequest.disableRollback, 'DISABLE_ROLLBACK', 'CloudTrail DisableRollback');
  requireOptionalFalse(eventRequest.includeNestedStacks, 'CREATE_SCOPE', 'CloudTrail IncludeNestedStacks');
  requireOptionalFalse(eventRequest.importExistingResources, 'CREATE_SCOPE', 'CloudTrail ImportExistingResources');
  requireOptionalEmptyArray(eventRequest.capabilities, 'CAPABILITIES', 'CloudTrail capabilities');
  requireOptionalEmptyArray(eventRequest.notificationARNs, 'CREATE_SCOPE', 'CloudTrail notificationARNs');
  requireOptionalEmptyArray(eventRequest.notificationArns, 'CREATE_SCOPE', 'CloudTrail notificationArns');
  requireOptionalEmptyArray(eventRequest.resourceTypes, 'CREATE_SCOPE', 'CloudTrail resource types');
  requireOptionalEmptyArray(eventRequest.resourcesToImport, 'CREATE_SCOPE', 'CloudTrail resources to import');
  requireOptionalAbsentString(eventRequest.roleARN, 'CREATE_SCOPE', 'CloudTrail roleARN');
  requireOptionalAbsentString(eventRequest.roleArn, 'CREATE_SCOPE', 'CloudTrail roleArn');
  requireOptionalAbsentString(eventRequest.templateURL, 'CREATE_SCOPE', 'CloudTrail templateURL');
  requireOptionalAbsentString(eventRequest.templateUrl, 'CREATE_SCOPE', 'CloudTrail templateUrl');
  requireEmptyRollbackConfiguration(eventRequest.rollbackConfiguration, 'CREATE_SCOPE', 'CloudTrail rollback configuration');
  for (const body of [eventRequest.templateBody, eventRequest.TemplateBody]) {
    if (body !== undefined && body !== null) {
      requireCondition(typeof body === 'string' && sha256(body) === templateSha, 'TEMPLATE_HASH', 'CloudTrail registra otro cuerpo de plantilla.');
    }
  }
  if (eventRequest.parameters !== undefined && eventRequest.parameters !== null) {
    requireExactCollection(normalizedParameters(eventRequest.parameters), expectedParameters(deploymentId), 'PARAMETERS', 'Los parámetros CloudTrail');
  }
  if (eventRequest.tags !== undefined && eventRequest.tags !== null) {
    requireExactCollection(normalizedTags(eventRequest.tags), expectedTags(deploymentId), 'TAGS', 'Los tags CloudTrail');
  }
  const eventResponse = requireObject(trail.responseElements, 'CREATE_CLOUDTRAIL', 'responseElements');
  requireCondition((eventResponse.id ?? eventResponse.changeSetId) === response.changeSetId, 'CREATE_CLOUDTRAIL', 'El ID del change set no correlaciona.');
  if (eventResponse.stackId !== undefined && eventResponse.stackId !== null) {
    requireCondition(eventResponse.stackId === response.stackId, 'CREATE_CLOUDTRAIL', 'El ID del stack contradice la respuesta guardada.');
  }
  return { requestedAt, respondedAt, changeSetId: response.changeSetId, stackId: response.stackId };
}

function validateChanges(changes) {
  requireCondition(Array.isArray(changes) && changes.length === 5, 'CHANGES_COUNT', 'Deben existir exactamente cinco cambios.');
  const observed = new Map();
  for (const entry of changes) {
    requireCondition(entry?.Type === 'Resource', 'CHANGE_ACTION', 'Cada cambio debe ser de tipo Resource.');
    const change = requireObject(entry?.ResourceChange, 'CHANGE_ACTION', 'ResourceChange');
    requireCondition(change.Action === 'Add', 'CHANGE_ACTION', 'Todos los cambios deben ser Add.');
    requireCondition(CONTRACT.logicalResources[change.LogicalResourceId] === change.ResourceType, 'CHANGE_ALLOWLIST', 'El recurso no pertenece a la allowlist exacta.');
    requireCondition(!observed.has(change.LogicalResourceId), 'CHANGE_ALLOWLIST', 'No se permiten recursos duplicados.');
    requireCondition(change.PhysicalResourceId === undefined || change.PhysicalResourceId === null || change.PhysicalResourceId === '', 'CHANGE_SCOPE', 'Un Add no puede referenciar un recurso físico existente.');
    requireOptionalEmptyObject(change.ResourceIdentifier, 'CHANGE_SCOPE', 'ResourceIdentifier');
    requireCondition(change.Replacement === undefined || change.Replacement === null || change.Replacement === 'False', 'CHANGE_REPLACEMENT', 'No se permite replacement.');
    requireCondition(change.PolicyAction === undefined || change.PolicyAction === null, 'CHANGE_SCOPE', 'No se permiten acciones de policy adicionales.');
    requireCondition(change.ModuleInfo === undefined || change.ModuleInfo === null, 'CHANGE_SCOPE', 'No se permiten módulos.');
    requireCondition(change.Scope === undefined || (Array.isArray(change.Scope) && change.Scope.length === 0), 'CHANGE_SCOPE', 'No se permite scope de modificación.');
    requireCondition(change.Details === undefined || (Array.isArray(change.Details) && change.Details.length === 0), 'CHANGE_SCOPE', 'No se permiten detalles de modificación.');
    observed.set(change.LogicalResourceId, change.ResourceType);
  }
  requireCondition(observed.size === Object.keys(CONTRACT.logicalResources).length, 'CHANGE_ALLOWLIST', 'La allowlist no está completa.');
}

function validateSnapshot(snapshot, label, context, identity, identityHash, deploymentId, templateBytes, createResult) {
  const value = requireObject(snapshot, 'SNAPSHOT', `El snapshot ${label}`);
  requireCondition(value.purpose === label, 'SNAPSHOT', `El propósito del snapshot debe ser ${label}.`);
  const startedAt = parseUtc(value.startedAt, 'SNAPSHOT_TIME', `${label}.startedAt`);
  const observedAt = parseUtc(value.observedAt, 'SNAPSHOT_TIME', `${label}.observedAt`);
  requireCondition(startedAt <= observedAt, 'SNAPSHOT_TIME', 'La ventana del snapshot es inválida.');
  validateIdentity(value.identity, context, identityHash, 'SNAPSHOT_IDENTITY');

  const changeSet = requireObject(value.describeChangeSet, 'CHANGE_SET', 'DescribeChangeSet');
  requireCondition(changeSet.Status === 'CREATE_COMPLETE' && changeSet.ExecutionStatus === 'AVAILABLE', 'CHANGE_SET_STATUS', 'El change set no está CREATE_COMPLETE/AVAILABLE.');
  if (hasOwn(changeSet, 'ChangeSetType') && changeSet.ChangeSetType !== null && changeSet.ChangeSetType !== undefined) {
    requireCondition(changeSet.ChangeSetType === 'CREATE', 'CHANGE_SET_TYPE_CONTRADICTION', 'ChangeSetType contradice el request CREATE.');
  }
  requireCondition(changeSet.StackName === CONTRACT.stackName && changeSet.StackId === createResult.stackId, 'CHANGE_SET', 'DescribeChangeSet pertenece a otro stack.');
  requireCondition(changeSet.ChangeSetName === context.changeSetName && changeSet.ChangeSetId === createResult.changeSetId, 'CHANGE_SET', 'DescribeChangeSet pertenece a otro cambio.');
  requireCondition(changeSet.Description === expectedDescription(sha256(templateBytes)), 'CHANGE_SET', 'DescribeChangeSet no conserva la descripción ligada a la plantilla.');
  requireCondition(changeSet.OnStackFailure === 'DO_NOTHING', 'ON_STACK_FAILURE', 'DescribeChangeSet debe registrar DO_NOTHING.');
  const deploymentMode = changeSet.DeploymentMode ?? changeSet.DeploymentConfig?.Mode;
  requireCondition(deploymentMode === 'STANDARD', 'DEPLOYMENT_MODE', 'El modo debe ser STANDARD.');
  requireCondition(changeSet.IncludeNestedStacks === false && changeSet.ImportExistingResources === false, 'CHANGE_SCOPE', 'No se permiten nested stacks ni imports.');
  requireCondition(Array.isArray(changeSet.Capabilities) && changeSet.Capabilities.length === 0, 'CAPABILITIES', 'DescribeChangeSet contiene capabilities.');
  requireOptionalEmptyArray(changeSet.NotificationARNs, 'CHANGE_SCOPE', 'DescribeChangeSet NotificationARNs');
  requireOptionalEmptyArray(changeSet.ResourceTypes, 'CHANGE_SCOPE', 'DescribeChangeSet ResourceTypes');
  requireOptionalEmptyArray(changeSet.ResourcesToImport, 'CHANGE_SCOPE', 'DescribeChangeSet ResourcesToImport');
  requireOptionalAbsentString(changeSet.RoleARN, 'CHANGE_SCOPE', 'DescribeChangeSet RoleARN');
  requireEmptyRollbackConfiguration(changeSet.RollbackConfiguration, 'CHANGE_SCOPE', 'DescribeChangeSet RollbackConfiguration');
  requireExactCollection(normalizedParameters(changeSet.Parameters), expectedParameters(deploymentId), 'PARAMETERS', 'Los parámetros descritos');
  requireExactCollection(normalizedTags(changeSet.Tags), expectedTags(deploymentId), 'TAGS', 'Los tags descritos');
  validateChanges(changeSet.Changes);

  const summaries = value.listChangeSets?.Summaries;
  requireCondition(Array.isArray(summaries) && summaries.length === 1, 'CHANGE_SET_COUNT', 'Debe existir un único change set.');
  const summary = summaries[0];
  requireCondition(summary.ChangeSetId === createResult.changeSetId && summary.ChangeSetName === context.changeSetName, 'CHANGE_SET_COUNT', 'ListChangeSets no correlaciona.');
  requireCondition(summary.Status === 'CREATE_COMPLETE' && summary.ExecutionStatus === 'AVAILABLE', 'CHANGE_SET_STATUS', 'El resumen no está disponible.');

  const stacks = value.describeStacks?.Stacks;
  requireCondition(Array.isArray(stacks) && stacks.length === 1, 'STACK_STATE', 'DescribeStacks debe devolver un único placeholder.');
  const stack = stacks[0];
  requireCondition(stack.StackName === CONTRACT.stackName && stack.StackId === createResult.stackId, 'STACK_STATE', 'El placeholder pertenece a otro stack.');
  requireCondition(stack.StackStatus === 'REVIEW_IN_PROGRESS', 'STACK_STATUS', 'El stack debe seguir REVIEW_IN_PROGRESS.');
  const disableRollback = changeSet.DeploymentConfig?.DisableRollback ?? changeSet.DisableRollback ?? stack.DisableRollback;
  requireCondition(disableRollback === false, 'DISABLE_ROLLBACK', 'El placeholder debe registrar DisableRollback=false.');
  requireCondition(!hasOwn(stack, 'Outputs') || (Array.isArray(stack.Outputs) && stack.Outputs.length === 0), 'STACK_NOT_EMPTY', 'El placeholder no debe tener outputs.');
  requireCondition(!hasOwn(stack, 'Parameters') || (Array.isArray(stack.Parameters) && stack.Parameters.length === 0), 'STACK_NOT_EMPTY', 'El placeholder no debe tener parámetros aplicados.');
  const resources = value.listStackResources?.StackResourceSummaries;
  requireCondition(Array.isArray(resources) && resources.length === 0, 'STACK_NOT_EMPTY', 'El placeholder no debe tener recursos.');

  const stackTemplate = requireObject(value.stackTemplateAbsence, 'STACK_TEMPLATE', 'La ausencia de template aplicado');
  requireCondition(stackTemplate.operation === 'GetTemplate' && stackTemplate.absent === true && stackTemplate.exitCode !== 0, 'STACK_TEMPLATE', 'GetTemplate del stack debe fallar por ausencia.');
  requireCondition(stackTemplate.errorCode === 'ValidationError' && stackTemplate.stackId === createResult.stackId, 'STACK_TEMPLATE', 'La ausencia de template no correlaciona.');
  requireCondition(stackTemplate.identitySha256 === identityHash, 'STACK_TEMPLATE', 'La identidad de GetTemplate no coincide.');

  const remote = strictBase64(value.remoteTemplateBodyBase64, 'TEMPLATE_REMOTE', 'remoteTemplateBodyBase64');
  requireCondition(remote.equals(templateBytes), 'TEMPLATE_REMOTE_MISMATCH', 'GetTemplate difiere byte por byte del archivo enviado.');
  requireCondition(value.remoteTemplateSha256 === sha256(templateBytes), 'TEMPLATE_REMOTE_MISMATCH', 'El hash remoto no coincide.');
  return { startedAt, observedAt };
}

export function validateAwsProof(evidence, options) {
  const value = requireObject(evidence, 'EVIDENCE', 'La evidencia');
  const phase = options.phase;
  requireCondition(phase === 'prepare' || phase === 'execute', 'PHASE', 'La fase debe ser prepare o execute.');
  requireCondition(value.schemaVersion === CONTRACT.schemaVersion && value.phase === phase, 'EVIDENCE', 'La versión o fase de evidencia no coincide.');

  const context = requireObject(value.context, 'CONTEXT', 'El contexto');
  requireCondition(context.project === CONTRACT.project && context.repository === CONTRACT.repository, 'CONTEXT', 'El proyecto o repositorio no coincide.');
  requireCondition(context.stackName === CONTRACT.stackName, 'STACK_NAME', 'El target debe estar fijado internamente.');
  requireCondition(context.environment === CONTRACT.environment && context.priceClass === CONTRACT.priceClass, 'CONTEXT', 'Entorno o price class no coinciden.');
  requireCondition(PROFILE_PATTERN.test(context.profile) && REGION_PATTERN.test(context.region), 'CONTEXT', 'Profile o región no son válidos.');
  requireCondition(UUID_PATTERN.test(context.attemptId), 'ATTEMPT_ID', 'El attempt ID no es UUID.');
  requireCondition(TOKEN_PATTERN.test(context.clientToken), 'CLIENT_TOKEN', 'El client token no es válido.');
  requireCondition(new RegExp(`^${CONTRACT.project}-create-\\d{8}T\\d{6}Z-[a-f0-9]{12}$`).test(context.changeSetName), 'CHANGE_SET_NAME', 'El nombre del change set no fue generado internamente.');
  requireCondition(context.gitClean === true, 'GIT_STATE', 'El commit aprobado debe estar limpio.');
  requireCondition(COMMIT_PATTERN.test(context.commitSha) && context.commitSha === options.expectedCommitSha, 'COMMIT_SHA', 'El commit aprobado no coincide.');
  requireCondition(context.confirmedCommitSha === context.commitSha, 'COMMIT_CONFIRMATION', 'La confirmación de commit no coincide.');
  requireSha(context.identitySha256, 'IDENTITY_HASH', 'El hash de identidad');
  requireCondition(context.confirmedIdentitySha === context.identitySha256 && context.confirmedIdentitySha === options.expectedIdentitySha, 'IDENTITY_CONFIRMATION', 'La confirmación de identidad no coincide.');
  const createdAt = parseUtc(context.createdAt, 'ATTEMPT_TIME', 'attempt.createdAt');
  requireCondition(/^\d{8}T\d{6}Z$/.test(context.changeSetName.split('-create-')[1].slice(0, 16)), 'CHANGE_SET_NAME', 'El nombre no contiene timestamp UTC estable.');
  requireSha(value.integrity?.inputChainSha256, 'EVIDENCE_CHAIN', 'El hash de la cadena de entrada');
  requireCondition(value.integrity.inputChainSha256 === options.inputChainSha256, 'EVIDENCE_CHAIN', 'La cadena sellada no coincide.');

  const templateBytes = Buffer.isBuffer(options.templateBytes) ? options.templateBytes : Buffer.from(options.templateBytes);
  const commitTemplateBytes = Buffer.isBuffer(options.commitTemplateBytes) ? options.commitTemplateBytes : Buffer.from(options.commitTemplateBytes);
  const template = validateTemplateEvidence(value.template, templateBytes, commitTemplateBytes);
  const identity = validateIdentity(value.identity, context, context.identitySha256);
  requireCondition(context.identitySha256 === identitySha256(identity), 'IDENTITY_HASH', 'La identidad completa no coincide.');
  const expectedDeploymentId = deriveDeploymentId(identity.accountId, context.region);
  requireCondition(context.deploymentId === expectedDeploymentId, 'DEPLOYMENT_ID', 'DeploymentId no deriva de cuenta, región y stack.');

  const reviewedRequestTime = parseUtc(value.create?.request?.requestedAt, 'CREATE_REQUEST', 'CreateChangeSet.requestedAt');
  requireCondition(reviewedRequestTime >= createdAt, 'CREATE_REQUEST', 'CreateChangeSet precede al intento.');
  const create = validateCreate(value.create, context, identity, reviewedRequestTime, expectedDeploymentId, template.sha256, context.clientToken, context.changeSetName);
  validatePreflight(value.preflight, context, identity, context.identitySha256, create.requestedAt);
  const prepare = validateSnapshot(value.snapshots?.prepare, 'prepare-review', context, identity, context.identitySha256, expectedDeploymentId, templateBytes, create);
  requireCondition(prepare.startedAt >= create.respondedAt, 'SNAPSHOT_TIME', 'El snapshot prepare precede a la creación.');

  let freshnessStartedAt = prepare.startedAt;
  let latest = prepare.observedAt;
  if (phase === 'execute') {
    requireCondition(hasOwn(value.snapshots, 'toctou'), 'TOCTOU_REQUIRED', 'Falta el snapshot TOCTOU inmediatamente anterior a execute.');
    const toctou = validateSnapshot(value.snapshots.toctou, 'before-execute', context, identity, context.identitySha256, expectedDeploymentId, templateBytes, create);
    requireCondition(toctou.startedAt >= prepare.observedAt, 'TOCTOU_ORDER', 'El snapshot TOCTOU precede al snapshot revisado.');
    freshnessStartedAt = toctou.startedAt;
    latest = toctou.observedAt;
  }

  const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now ?? new Date());
  requireCondition(Number.isFinite(now) && latest <= now + 5_000, 'TIMESTAMP_FUTURE', 'La evidencia tiene timestamps futuros.');
  requireCondition(now - freshnessStartedAt <= CONTRACT.maxFreshnessMs, 'TIMESTAMP_STALE', 'La observación más antigua del snapshot final supera 300 segundos.');

  if (options.executionBinding !== undefined) {
    requireCondition(phase === 'execute', 'EXECUTE_BINDING', 'La vinculación de ejecución solo admite evidencia execute.');
    const binding = requireObject(options.executionBinding, 'EXECUTE_BINDING', 'La vinculación de ejecución');
    const pointer = requireObject(binding.pointer, 'EXECUTE_BINDING', 'El puntero privado');
    const attempt = requireObject(binding.attempt, 'EXECUTE_BINDING', 'El intento sellado');
    const response = requireObject(value.create?.response, 'EXECUTE_BINDING', 'La respuesta de creación aprobada');
    const bindingMatches =
      pointer.attemptId === context.attemptId && attempt.attemptId === context.attemptId &&
      pointer.stackName === CONTRACT.stackName && attempt.stackName === CONTRACT.stackName &&
      pointer.profile === context.profile && attempt.profile === context.profile &&
      pointer.region === context.region && attempt.region === context.region &&
      pointer.commitSha === context.commitSha && attempt.commitSha === context.commitSha &&
      pointer.identitySha256 === context.identitySha256 && attempt.confirmedIdentitySha === context.identitySha256 &&
      pointer.templateSha256 === template.sha256 && attempt.templateSha256 === template.sha256 &&
      pointer.changeSetName === context.changeSetName && attempt.changeSetName === context.changeSetName &&
      pointer.stackId === response.stackId && pointer.changeSetId === response.changeSetId &&
      pointer.clientToken === context.clientToken && attempt.clientToken === context.clientToken;
    requireCondition(bindingMatches, 'EXECUTE_BINDING', 'El puntero, el intento sellado y la evidencia aprobada no coinciden exactamente.');
  }

  return {
    fixedTarget: true,
    templateCanonical: true,
    identityMatched: true,
    absenceCorrelated: true,
    createCorrelated: true,
    fiveAllowedAdds: true,
    toctouFresh: phase === 'execute'
  };
}

export function normalizeCloudTrailEvent(event) {
  const value = requireObject(event, 'CLOUDTRAIL_EVENT', 'El evento CloudTrail');
  const principalArn = value.userIdentity?.arn ?? value.userIdentity?.sessionContext?.sessionIssuer?.arn;
  return {
    eventName: value.eventName,
    eventTime: value.eventTime,
    eventId: value.eventID ?? value.eventId,
    requestId: value.requestID ?? value.requestId,
    awsRegion: value.awsRegion,
    recipientAccountId: value.recipientAccountId,
    principalArn,
    errorCode: value.errorCode ?? null,
    errorMessage: value.errorMessage ?? null,
    requestParameters: value.requestParameters ?? {},
    responseElements: value.responseElements ?? null,
    stackName: value.requestParameters?.stackName
  };
}

export function selectCloudTrailEvent(events, { kind, context, identity, expectedRequestId = null }) {
  requireCondition(Array.isArray(events), 'CLOUDTRAIL_EVENTS', 'Events debe ser una lista.');
  const expectedName = kind === 'absence' ? 'DescribeStacks' : 'CreateChangeSet';
  if (kind === 'absence') requireString(expectedRequestId, 'ABSENCE_CLOUDTRAIL', 'DescribeStacks requestId esperado');
  const matches = events.map((entry) => {
    const raw = typeof entry.CloudTrailEvent === 'string' ? JSON.parse(entry.CloudTrailEvent) : entry;
    return { raw, normalized: normalizeCloudTrailEvent(raw) };
  }).filter(({ normalized }) => {
    if (normalized.eventName !== expectedName || normalized.awsRegion !== context.region || normalized.recipientAccountId !== identity.accountId || normalized.principalArn !== identity.principalArn) return false;
    if (normalized.requestParameters.stackName !== CONTRACT.stackName) return false;
    if (kind === 'absence') return normalized.errorCode === 'ValidationError' && normalized.requestId === expectedRequestId;
    return normalized.errorCode === null && normalized.requestParameters.changeSetName === context.changeSetName && normalized.requestParameters.clientToken === context.clientToken;
  });
  requireCondition(matches.length <= 1, 'CLOUDTRAIL_AMBIGUOUS', 'Más de un evento CloudTrail coincide con el intento.');
  requireCondition(matches.length === 1, 'CLOUDTRAIL_NOT_FOUND', 'Aún no existe un evento CloudTrail exacto.');
  return matches[0].raw;
}

export function computeChainDigest(entries, previousChainFileSha256 = null) {
  requireCondition(Array.isArray(entries) && entries.length > 0, 'EVIDENCE_CHAIN', 'La cadena debe incluir archivos.');
  if (previousChainFileSha256 !== null) requireSha(previousChainFileSha256, 'EVIDENCE_CHAIN', 'previousChainFileSha256');
  const normalized = entries.map((entry) => ({ path: entry.path, sha256: requireSha(entry.sha256, 'EVIDENCE_CHAIN', `hash de ${entry.path}`) }));
  requireCondition(new Set(normalized.map((entry) => entry.path)).size === normalized.length, 'EVIDENCE_CHAIN', 'La cadena contiene rutas duplicadas.');
  return sha256(canonicalJson({ version: 1, previousChainFileSha256, entries: normalized }));
}

export function validateShareableReport(report) {
  const walk = (value, path) => {
    if (typeof value === 'boolean') return;
    if (typeof value === 'string' && SHA256_PATTERN.test(value)) return;
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'REPORT_REDACTION', `${path} contiene un valor compartible prohibido.`);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  requireObject(report, 'REPORT_REDACTION', 'El reporte compartible');
  walk(report, 'report');
  return true;
}

export function buildShareableReport({ evidenceBytes, chainBytes, proofSummary, templateSha256, commitSha, identityHash }) {
  const report = {
    checks: {
      absenceCorrelated: proofSummary.absenceCorrelated === true,
      createCorrelated: proofSummary.createCorrelated === true,
      fiveAllowedAdds: proofSummary.fiveAllowedAdds === true,
      fixedTarget: proofSummary.fixedTarget === true,
      identityMatched: proofSummary.identityMatched === true,
      templateCanonical: proofSummary.templateCanonical === true,
      toctouFresh: proofSummary.toctouFresh === true
    },
    hashes: {
      chainFileSha256: sha256(chainBytes),
      commitReferenceSha256: sha256(commitSha),
      evidenceSha256: sha256(evidenceBytes),
      identityReferenceSha256: identityHash,
      templateSha256
    }
  };
  validateShareableReport(report);
  return report;
}
