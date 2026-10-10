import { recipes } from '../adapters/recipes.js';
import {
  generateKeyPairSync,
  sign,
  verify,
  randomUUID,
  createPublicKey,
} from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistencePort } from '../ports/store.js';
import type { RunnerPort, CheckPort } from '../ports/agents.js';
import type {
  OperationRequest,
  OperationRecord,
  BuildPayload,
  BuildResult,
} from '../ports/guard.js';
import type {
  AuthorityGrant,
  ProjectProfile,
  FactoryRelease,
  Models,
  EvidenceReceipt,
} from '../domain/contracts.js';
import { contract } from '../adapters/contracts.js';
import {
  ensure,
  validateMission,
  validateHandoff,
  inScope,
  FactoryError,
} from '../domain/invariants.js';
import {
  canonical,
  digest,
  type Tree,
  treeDigest,
  trackedSnapshot,
  validateCandidate,
  writeTree,
  readTree,
} from '../adapters/artifacts.js';
import { redact, rejectSecrets } from '../adapters/logging.js';
import { checkVersion, ProtectedChecks } from '../adapters/checks.js';
import { DockerRunner } from '../adapters/docker.js';
export interface GuardConfig {
  root: string;
  development: boolean;
  caller: string;
  projects: ProjectProfile[];
  models: Models;
  secrets: string[];
  runtimeRoot?: string;
  policyFile?: string;
}
export class GuardService {
  private privateKey = '';
  public publicKey = '';
  private active = new Map<string, AbortController>();
  constructor(
    public readonly config: GuardConfig,
    public readonly store: PersistencePort,
    public readonly runner: RunnerPort,
    private checks: CheckPort,
  ) {}
  async initialize() {
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    if (!this.config.development) {
      ensure(
        this.config.runtimeRoot,
        'isolation',
        'Runtime ownership path required',
      );
      const guard = await stat(this.config.root),
        runtime = await stat(this.config.runtimeRoot);
      ensure(
        guard.uid === process.getuid?.() &&
          guard.uid !== 0 &&
          runtime.uid !== guard.uid &&
          (guard.mode & 0o077) === 0,
        'isolation',
        'Guard needs a private directory and a different nonroot OS identity',
      );
      ensure(
        this.config.policyFile,
        'isolation',
        'Private Guard policy file required',
      );
      const policy = await stat(this.config.policyFile);
      ensure(
        policy.uid === guard.uid && (policy.mode & 0o077) === 0,
        'isolation',
        'Guard policy must be private and Guard-owned',
      );
      ensure(
        this.runner instanceof DockerRunner,
        'isolation',
        'Live requires Docker driver',
      );
      ensure(
        this.checks instanceof ProtectedChecks && this.checks.dockerIsolated,
        'isolation',
        'Live requires separate Docker product checks',
      );
      const probe = await this.runner.probe();
      ensure(
        probe.dockerReady && probe.imageVerified && probe.credentials,
        'BLOCKED',
        'Live isolation or Codex authentication not ready',
      );
    }
    const path = join(this.config.root, 'signing-key.pem');
    try {
      this.privateKey = await readFile(path, 'utf8');
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
      const keys = generateKeyPairSync('ed25519');
      this.privateKey = keys.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString();
      await writeFile(path, this.privateKey, { mode: 0o600, flag: 'wx' });
    }
    this.publicKey = createPublicKey(this.privateKey)
      .export({ format: 'pem', type: 'spki' })
      .toString();
    if (!(await this.store.get('release', 'baseline'))) {
      const recipe = recipes().find((r) => r.role === 'builder');
      ensure(recipe, 'recipe', 'Builder recipe required');
      const release: FactoryRelease = {
        id: 'baseline',
        parent: null,
        kind: 'recipe',
        recipe,
        projectIds: this.config.projects.map((p) => p.id),
        taskTypes: [...new Set(this.config.projects.map((p) => p.taskType))],
        experimentId: null,
        stage: 'stable',
        createdAt: new Date().toISOString(),
      };
      await this.store.commit(
        [
          {
            kind: 'release',
            id: release.id,
            expectedVersion: 0,
            value: release,
          },
        ],
        {
          id: 'initial-release',
          topic: 'release.created',
          payload: { id: release.id },
        },
      );
    }
    // Pending operations are never replayed after a process restart.
    for (const row of await this.store.list<OperationRecord>('operation')) {
      if (row.value.state === 'pending')
        await this.store.commit(
          [
            {
              kind: 'operation',
              id: row.id,
              expectedVersion: row.version,
              value: { ...row.value, state: 'uncertain' },
            },
          ],
          {
            id: `uncertain-${row.id}`,
            topic: 'operation.uncertain',
            payload: { id: row.id },
          },
        );
      if (row.value.state === 'completed') {
        const id = row.id;
        let cost: number | null = 0;
        if (row.value.request.type === 'build')
          cost = (row.value.result as BuildResult).fact.usage.usd;
        await this.store.settle(id, cost);
      }
    }
    for (const row of await this.store.list<
      import('../domain/contracts.js').Experiment
    >('experiment'))
      if (row.value.status === 'evaluating')
        await this.store.commit(
          [
            {
              kind: 'experiment',
              id: row.id,
              expectedVersion: row.version,
              value: { ...row.value, status: 'held' },
            },
          ],
          {
            id: `interrupted-${row.id}`,
            topic: 'experiment.held',
            payload: { id: row.id },
          },
        );
  }
  signature(value: unknown) {
    return sign(null, Buffer.from(canonical(value)), this.privateKey).toString(
      'base64',
    );
  }
  verify(value: unknown, signature: string) {
    return verify(
      null,
      Buffer.from(canonical(value)),
      this.publicKey,
      Buffer.from(signature, 'base64'),
    );
  }
  async info() {
    const info = {
      development: this.config.development,
      uid: (await stat(this.config.root)).uid,
      root: this.config.root,
      publicKey: this.publicKey,
      models: this.config.models,
      privatePaths: [
        join(this.config.root, 'signing-key.pem'),
        join(this.config.root, 'guard.db'),
        ...this.config.projects.map((p) => p.checkRoot),
      ],
    };
    if (this.config.policyFile) info.privatePaths.push(this.config.policyFile);
    if (this.runner instanceof DockerRunner)
      return { ...info, ...(await this.runner.probe()) };
    return {
      ...info,
      dockerReady: false,
      imageVerified: false,
      credentials: false,
    };
  }
  async operator(method: string, params: unknown): Promise<unknown> {
    if (method === 'public-key') return { publicKey: this.publicKey };
    if (method === 'authorize-retry') {
      ensure(typeof params === 'string', 'schema', 'Operation ID required');
      const row = await this.store.get<OperationRecord>('operation', params);
      ensure(
        row &&
          row.value.request.type === 'build' &&
          (row.value.state === 'uncertain' ||
            (row.value.state === 'completed' &&
              (row.value.result as BuildResult).fact.outcome === 'refused')),
        'operation',
        'Only an uncertain or refused isolated build can be explicitly retried',
      );
      ensure(
        await this.runner.stop(params),
        'uncertain',
        'Old execution has not stopped',
      );
      await this.store.commit(
        [
          {
            kind: 'operation',
            id: params,
            expectedVersion: row.version,
            value: { ...row.value, retryAllowed: true },
          },
        ],
        {
          id: `retry-${params}`,
          topic: 'operation.retry-authorized',
          payload: { id: params },
        },
      );
      return { id: params, retryAllowed: true };
    }
    if (method === 'grant') {
      ensure(
        params &&
          typeof params === 'object' &&
          'grant' in params &&
          'mission' in params,
        'schema',
        'Grant and mission required',
      );
      const grant = contract('AuthorityGrant', params.grant),
        mission = contract('MissionRevision', params.mission);
      validateMission(mission);
      const profile = this.profile(mission.projectId);
      ensure(
        grant.caller === this.config.caller &&
          grant.missionId === mission.id &&
          grant.projectId === mission.projectId &&
          grant.missionDigest === digest(mission) &&
          grant.releaseId === mission.factoryRelease,
        'grant',
        'Grant target mismatch',
      );
      ensure(
        grant.operations.every((o) =>
          mission.delegation.operations.includes(o),
        ) &&
          grant.scope.every((p) => inScope(p, mission.scope)) &&
          grant.maxUsd <= mission.budget.maxUsd,
        'grant',
        'Grant exceeds mission authority',
      );
      ensure(
        mission.scope.every((p) => inScope(p, profile.scope)) &&
          mission.acceptance.every((a) =>
            profile.acceptance.some((p) => canonical(p) === canonical(a)),
          ) &&
          mission.acceptance.length === profile.acceptance.length,
        'grant',
        'Mission changed protected project acceptance/scope',
      );
      ensure(
        mission.delegation.operations.every((o) =>
          profile.delegation.operations.includes(o),
        ) &&
          (!mission.delegation.autoRecipe || profile.delegation.autoRecipe) &&
          mission.budget.maxUsd <= profile.budget.maxUsd &&
          mission.budget.maxAttempts <= profile.budget.maxAttempts &&
          mission.budget.maxMinutes <= profile.budget.maxMinutes,
        'grant',
        'Mission exceeds registered project authority',
      );
      const old = await this.store.get<
        import('../domain/contracts.js').MissionRevision
      >('mission', mission.id);
      ensure(
        !old ||
          (mission.parentRevision === old.value.revision &&
            mission.revision === old.value.revision + 1 &&
            canonical(mission.acceptance) === canonical(old.value.acceptance) &&
            canonical(mission.scope) === canonical(old.value.scope)),
        'revision',
        'Mission revision must preserve acceptance and scope',
      );
      await this.store.commit(
        [
          { kind: 'grant', id: grant.id, expectedVersion: 0, value: grant },
          {
            kind: 'mission',
            id: mission.id,
            expectedVersion: old?.version ?? 0,
            value: mission,
          },
          {
            kind: 'mission-revision',
            id: `${mission.id}-${mission.revision}`,
            expectedVersion: 0,
            value: mission,
          },
        ],
        {
          id: `grant-${grant.id}`,
          topic: 'grant.issued',
          payload: { id: grant.id },
        },
      );
      return grant;
    }
    throw new FactoryError('operation', 'Unknown operator operation');
  }
  profile(id: string) {
    const profile = this.config.projects.find((p) => p.id === id);
    ensure(profile, 'project', 'Project not registered by operator');
    return profile;
  }
  async releaseFor(
    projectId: string,
    taskType: string,
  ): Promise<FactoryRelease> {
    const releases = (await this.store.list<FactoryRelease>('release'))
      .map((r) => r.value)
      .filter(
        (r) =>
          ['stable', 'canary'].includes(r.stage) &&
          r.projectIds.includes(projectId) &&
          r.taskTypes.includes(taskType),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    ensure(releases[0], 'release', 'No applicable release');
    return releases[0];
  }
  async release(id: string): Promise<FactoryRelease> {
    const row = await this.store.get<FactoryRelease>('release', id);
    ensure(row, 'release', 'Unknown release');
    return row.value;
  }
  async authorize(request: OperationRequest): Promise<AuthorityGrant> {
    ensure(
      !(await this.store.get('cancelled-mission', request.mission.id)),
      'cancelled',
      'Mission was cancelled',
    );
    const grant = (
      await this.store.get<AuthorityGrant>('grant', request.grantId)
    )?.value;
    ensure(grant, 'grant', 'Grant missing');
    ensure(
      grant.caller === this.config.caller &&
        Date.parse(grant.expiresAt) > Date.now(),
      'grant',
      'Caller or expiry invalid',
    );
    ensure(
      grant.missionId === request.mission.id &&
        grant.projectId === request.mission.projectId &&
        grant.missionDigest === digest(request.mission) &&
        grant.releaseId === request.mission.factoryRelease,
      'grant',
      'Grant digest/target mismatch',
    );
    ensure(
      grant.operations.includes(request.type),
      'grant',
      'Operation not delegated',
    );
    const current = await this.store.get('mission', request.mission.id);
    ensure(
      current && digest(current.value) === digest(request.mission),
      'revision',
      'Old mission revision cannot dispatch new operations',
    );
    ensure(
      (await this.release(grant.releaseId)).stage !== 'revoked',
      'revoked',
      'Release is revoked; new operations blocked',
    );
    return grant;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    if (method === 'cancelMission') {
      ensure(typeof params === 'string', 'schema', 'Mission ID required');
      const old = await this.store.get('cancelled-mission', params);
      if (!old)
        await this.store.commit(
          [
            {
              kind: 'cancelled-mission',
              id: params,
              expectedVersion: 0,
              value: { at: new Date().toISOString() },
            },
          ],
          {
            id: `cancel-${params}`,
            topic: 'mission.cancelled',
            payload: { id: params },
          },
        );
      const operations = (
        await this.store.list<OperationRecord>('operation')
      ).filter(
        (o) =>
          o.value.request.mission.id === params && o.value.state === 'pending',
      );
      const stopped = [];
      for (const operation of operations) {
        this.active.get(operation.id)?.abort();
        stopped.push({
          id: operation.id,
          stopped: await this.runner.stop(operation.id),
        });
      }
      return { stopped };
    }
    if (method === 'authorizeRole') {
      ensure(
        params &&
          typeof params === 'object' &&
          'mission' in params &&
          'grantId' in params &&
          typeof params.grantId === 'string',
        'schema',
        'Invalid role authorization',
      );
      const mission = contract('MissionRevision', params.mission);
      await this.authorize({
        id: 'role-authorization',
        grantId: params.grantId,
        mission,
        type: 'snapshot',
        targetDigest: digest('snapshot'),
        amount: 0.01,
        payload: {},
      });
      return { authorized: true };
    }
    if (method === 'info') return this.info();
    if (method === 'releaseStatus')
      return (await this.store.list<FactoryRelease>('release')).map(
        (r) => r.value,
      );
    if (method === 'artifact') {
      ensure(typeof params === 'string', 'schema', 'Mission ID required');
      const sealed = (await this.store.list<OperationRecord>('operation')).find(
        (r) =>
          r.value.request.type === 'seal' &&
          r.value.state === 'completed' &&
          r.value.request.mission.id === params,
      );
      ensure(sealed, 'artifact', 'No delivered artifact');
      const target = sealed.value.request.targetDigest;
      const tree = await readTree(join(this.config.root, 'artifacts', target));
      ensure(
        treeDigest(tree) === target,
        'digest',
        'Sealed bytes changed after verification',
      );
      return { digest: target, tree };
    }
    if (method === 'releaseFor') {
      ensure(
        params &&
          typeof params === 'object' &&
          'projectId' in params &&
          'taskType' in params &&
          typeof params.projectId === 'string' &&
          typeof params.taskType === 'string',
        'schema',
        'Invalid release selector',
      );
      return this.releaseFor(params.projectId, params.taskType);
    }
    if (method === 'operationStatus') {
      ensure(typeof params === 'string', 'schema', 'Operation ID required');
      return (
        (await this.store.get<OperationRecord>('operation', params))?.value ??
        null
      );
    }
    if (method === 'stop') {
      ensure(typeof params === 'string', 'schema', 'Operation ID required');
      this.active.get(params)?.abort();
      return this.runner.stop(params);
    }
    if (method === 'reconcile') {
      ensure(typeof params === 'string', 'schema', 'Operation ID required');
      const row = await this.store.get<OperationRecord>('operation', params);
      ensure(row, 'operation', 'Unknown operation');
      this.active.get(params)?.abort();
      const stopped = await this.runner.stop(params);
      return {
        state: row.value.state,
        stopped,
        result: row.value.result,
        retryAllowed: row.value.retryAllowed === true,
      };
    }
    if (method === 'operate') return this.operate(params);
    throw new FactoryError('operation', 'Unregistered operation');
  }
  private sanitize(value: unknown) {
    rejectSecrets(value, this.config.secrets);
  }
  async operate(raw: unknown): Promise<unknown> {
    ensure(raw && typeof raw === 'object', 'schema', 'Invalid operation');
    const allowed = [
      'id',
      'grantId',
      'mission',
      'type',
      'targetDigest',
      'amount',
      'payload',
    ];
    ensure(
      Object.keys(raw).every((k) => allowed.includes(k)) &&
        allowed.every((k) => k in raw),
      'schema',
      'Invalid operation fields',
    );
    const request = raw as OperationRequest;
    ensure(
      /^[a-zA-Z0-9_.-]{1,120}$/.test(request.id) &&
        typeof request.amount === 'number' &&
        request.amount > 0 &&
        ['snapshot', 'build', 'check', 'seal'].includes(request.type),
      'schema',
      'Invalid operation',
    );
    request.mission = contract('MissionRevision', request.mission);
    const hash = digest(request),
      existing = await this.store.get<OperationRecord>('operation', request.id);
    if (existing) {
      ensure(
        existing.value.digest === hash,
        'duplicate-conflict',
        'Operation ID reused with different request',
      );
      ensure(
        existing.value.state === 'completed',
        'uncertain',
        'Operation in flight or uncertain; reconcile first',
      );
      return existing.value.result;
    }
    const grant = await this.authorize(request);
    this.sanitize(request);
    await this.store.reserve(
      request.id,
      grant.id,
      request.amount,
      grant.maxUsd,
    );
    const record: OperationRecord = {
      request,
      digest: hash,
      state: 'pending',
      result: null,
    };
    const intent = await this.store.commit(
      [
        {
          kind: 'operation',
          id: request.id,
          expectedVersion: 0,
          value: record,
        },
      ],
      {
        id: `intent-${request.id}`,
        topic: 'operation.intent',
        payload: { id: request.id },
      },
    );
    ensure(
      !intent.duplicate,
      'uncertain',
      'Operation in flight or uncertain; reconcile first',
    );
    const controller = new AbortController();
    this.active.set(request.id, controller);
    let result: unknown;
    try {
      result = await this.execute(request, grant, controller.signal);
      ensure(
        !controller.signal.aborted,
        'cancelled',
        'Operation cancelled before result acceptance',
      );
      this.sanitize(result);
      // A test-only kill is configured on the Guard process, never accepted in a request.
      if (
        this.config.development &&
        process.env.FACTORY_FAULT === 'after-effect'
      )
        process.kill(process.pid, 'SIGKILL');
      await this.store.commit(
        [
          {
            kind: 'operation',
            id: request.id,
            expectedVersion: 1,
            value: { ...record, state: 'completed', result },
          },
        ],
        {
          id: `result-${request.id}`,
          topic: 'operation.completed',
          payload: { id: request.id },
        },
      );
      let cost: number | null = 0;
      if (request.type === 'build')
        cost = (result as BuildResult).fact.usage.usd;
      await this.store.settle(request.id, cost);
      return result;
    } catch (e) {
      const row = await this.store.get<OperationRecord>(
        'operation',
        request.id,
      );
      if (row?.value.state === 'pending')
        await this.store.commit(
          [
            {
              kind: 'operation',
              id: request.id,
              expectedVersion: row.version,
              value: { ...record, state: 'uncertain' },
            },
          ],
          {
            id: `error-${request.id}`,
            topic: 'operation.uncertain',
            payload: { id: request.id },
          },
        );
      await this.store.settle(request.id, null);
      throw e;
    } finally {
      this.active.delete(request.id);
    }
  }
  private async execute(
    r: OperationRequest,
    grant: AuthorityGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    const profile = this.profile(r.mission.projectId);
    if (r.type === 'snapshot') {
      const old = await this.store.get('snapshot', r.mission.id);
      if (old) return old.value;
      const snapshot = await trackedSnapshot(profile.repository);
      const value = { ...snapshot, digest: treeDigest(snapshot.tree) };
      await this.store.commit(
        [{ kind: 'snapshot', id: r.mission.id, expectedVersion: 0, value }],
        {
          id: `snapshot-${r.mission.id}`,
          topic: 'snapshot.created',
          payload: { id: r.mission.id },
        },
      );
      return value;
    }
    ensure(
      r.payload && typeof r.payload === 'object' && 'tree' in r.payload,
      'schema',
      'Operation tree required',
    );
    const tree = r.payload.tree as Tree;
    ensure(
      treeDigest(tree) === r.targetDigest,
      'digest',
      'Target digest mismatch',
    );
    const snapshot = await this.store.get<{ tree: Tree }>(
      'snapshot',
      r.mission.id,
    );
    ensure(snapshot, 'snapshot', 'Mission baseline missing');
    validateCandidate(snapshot.value.tree, tree, grant.scope);
    if (r.type === 'build') {
      const payload = r.payload as BuildPayload;
      const attempt = contract('Attempt', payload.attempt),
        recipe = contract('RoleRecipe', payload.recipe);
      ensure(
        r.amount >= recipe.budgetUsd,
        'budget',
        'Reservation is below recipe budget',
      );
      ensure(
        attempt.missionId === r.mission.id &&
          attempt.operationId === r.id &&
          attempt.baseDigest === r.targetDigest,
        'attempt',
        'Attempt target mismatch',
      );
      ensure(
        recipe.scope.every((p) => inScope(p, grant.scope)),
        'scope',
        'Builder scope outside grant',
      );
      const release = await this.release(r.mission.factoryRelease);
      ensure(
        canonical({ ...recipe, scope: release.recipe.scope }) ===
          canonical(release.recipe) &&
          recipe.promptDigest === digest(recipe.prompt),
        'recipe',
        'Unregistered recipe or capability change',
      );
      const out = await this.runner.run(
        attempt,
        tree,
        redact(payload.prompt, this.config.secrets),
        recipe,
        this.config.models.engineer,
        signal,
      );
      ensure(out.fact.stopped, 'uncertain', 'Worker stop not verified');
      validateCandidate(tree, out.tree, recipe.scope);
      if (out.fact.handoff) {
        validateHandoff(out.fact.handoff, { ...attempt, stopped: true });
        ensure(
          out.fact.handoff.candidateDigest === treeDigest(out.tree),
          'digest',
          'Returned candidate digest mismatch',
        );
      }
      return out;
    }
    if (r.type === 'check') {
      const results = await this.checks.run(tree, profile, signal);
      ensure(!signal.aborted, 'cancelled', 'Check cancelled before evidence');
      const receipts: EvidenceReceipt[] = [];
      for (const result of results) {
        const spec = profile.checks.find((c) => c.id === result.checkId);
        ensure(spec, 'check', 'Unregistered check');
        const identity = {
          id: randomUUID(),
          missionId: r.mission.id,
          targetDigest: r.targetDigest,
          inputDigest: digest({ mission: r.mission, checks: profile.checks }),
          checkId: spec.id,
          checkVersion: spec.version,
        };
        let environment: string;
        if (this.config.development) environment = 'fake-development-host';
        else environment = 'docker-isolated';
        const issuedAt = new Date().toISOString();
        let outcome: EvidenceReceipt['result'] = 'fail';
        if (result.passed) outcome = 'pass';
        const receipt = {
          ...identity,
          environment,
          issuedAt,
          result: outcome,
          issuer: digest(this.publicKey),
        };
        const signed: EvidenceReceipt = {
          ...receipt,
          signature: this.signature(receipt),
        };
        receipts.push(signed);
        await this.store.commit(
          [
            {
              kind: 'evidence',
              id: signed.id,
              expectedVersion: 0,
              value: signed,
            },
          ],
          {
            id: `evidence-${signed.id}`,
            topic: 'evidence.issued',
            payload: { id: signed.id },
          },
        );
      }
      return { receipts };
    }
    ensure('bundle' in r.payload, 'schema', 'Bundle required');
    const bundle = contract('ResultBundle', r.payload.bundle);
    ensure(
      bundle.missionId === r.mission.id &&
        bundle.factoryRelease === r.mission.factoryRelease &&
        bundle.status === 'completed' &&
        bundle.artifact?.digest === r.targetDigest &&
        bundle.unmet.length === 0,
      'acceptance',
      'Invalid completion bundle',
    );
    ensure(
      bundle.missionRevision === r.mission.revision &&
        r.mission.acceptance.every((a) => bundle.achieved.includes(a.id)),
      'acceptance',
      'Incomplete acceptance ledger',
    );
    const requiredChecks = new Set([
      ...profile.checks.map((check) => check.id),
      ...r.mission.acceptance.map((acceptance) => acceptance.checkId),
    ]);
    for (const checkId of requiredChecks) {
      const receipt = bundle.checks.find(
        (e) => e.checkId === checkId && e.result === 'pass',
      );
      ensure(receipt, 'evidence', 'Missing required evidence');
      const stored = await this.store.get<EvidenceReceipt>(
        'evidence',
        receipt.id,
      );
      let valid =
        stored &&
        canonical(stored.value) === canonical(receipt) &&
        receipt.targetDigest === r.targetDigest &&
        receipt.missionId === r.mission.id &&
        receipt.inputDigest ===
          digest({ mission: r.mission, checks: profile.checks });
      if (valid) {
        const environment = receipt.environment;
        if (this.config.development)
          valid = environment === 'fake-development-host';
        else valid = environment === 'docker-isolated';
      }
      ensure(valid, 'evidence', 'Stale or forged evidence');
      const spec = profile.checks.find((c) => c.id === receipt.checkId);
      ensure(
        spec &&
          spec.version === receipt.checkVersion &&
          (await checkVersion(profile.checkRoot, spec)) ===
            receipt.checkVersion,
        'evidence',
        'Check version changed',
      );
      const { signature, ...unsigned } = receipt;
      ensure(this.verify(unsigned, signature), 'evidence', 'Invalid signature');
    }
    const target = join(this.config.root, 'artifacts', r.targetDigest);
    await mkdir(join(this.config.root, 'artifacts'), { recursive: true });
    try {
      await writeTree(target, tree, true);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    }
    ensure(
      treeDigest(await readTree(target)) === r.targetDigest,
      'digest',
      'Sealed bytes changed',
    );
    const complete = {
      ...bundle,
      artifact: {
        digest: r.targetDigest,
        reference: `guard:sha256:${r.targetDigest}`,
      },
      completionSignature: null,
    };
    return {
      bundle: { ...complete, completionSignature: this.signature(complete) },
    };
  }
}
