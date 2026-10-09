import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { parseDocument, isAlias, isCollection, visit } from 'yaml';
import type * as C from '../domain/contracts.js';
import { ensure, FactoryError } from '../domain/invariants.js';
const schema: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL('../../../contracts/factory.schema.json', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv2020({
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  allErrors: true,
});
const addFormats = addFormatsImport.default ?? addFormatsImport;
addFormats(ajv);
ajv.addSchema(schema);
export interface ContractMap {
  MissionRevision: C.MissionRevision;
  MissionDraft: C.MissionDraft;
  PlanProposal: C.PlanProposal;
  WorkItem: C.WorkItem;
  Attempt: C.Attempt;
  Handoff: C.Handoff;
  EvidenceReceipt: C.EvidenceReceipt;
  AuthorityGrant: C.AuthorityGrant;
  Experiment: C.Experiment;
  FactoryRelease: C.FactoryRelease;
  ResultBundle: C.ResultBundle;
  RunnerFact: C.RunnerFact;
  AgentClaim: C.AgentClaim;
  RoleRecipe: C.RoleRecipe;
  ProjectProfile: C.ProjectProfile;
  Models: C.Models;
  RoleReport: C.RoleReport;
  RecipeProposal: C.RecipeProposal;
  Evaluation: C.Evaluation;
}
export function contract<K extends keyof ContractMap>(
  name: K,
  value: unknown,
): ContractMap[K] {
  const validator = ajv.getSchema<ContractMap[K]>(
    `https://software-factory.local/contracts/v1#/$defs/${name}`,
  );
  ensure(validator, 'schema', 'Unknown contract');
  if (!validator(value))
    throw new FactoryError(
      'schema',
      `${name}: ${ajv.errorsText(validator.errors).slice(0, 1500)}`,
    );
  return value as ContractMap[K];
}
export function contractSchema(
  name: keyof ContractMap,
): Record<string, unknown> {
  const all = schema.$defs;
  ensure(all && typeof all === 'object', 'schema', 'Definitions missing');
  const definitions: object = all;
  const selected: Record<string, unknown> = {};
  function collect(id: string): void {
    if (id in selected) return;
    ensure(id in definitions, 'schema', 'Definition missing');
    const definition: unknown = Reflect.get(definitions, id);
    selected[id] = definition;
    function visit(value: unknown): void {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        if ('$ref' in value && typeof value.$ref === 'string') {
          ensure(
            value.$ref.startsWith('#/$defs/'),
            'schema',
            'External schema references forbidden',
          );
          collect(value.$ref.slice(8));
        }
        Object.values(value).forEach(visit);
      }
    }
    visit(definition);
  }
  collect(name);
  return { $schema: schema.$schema, $ref: `#/$defs/${name}`, $defs: selected };
}
export function parseYaml(text: string): unknown {
  ensure(Buffer.byteLength(text) <= 256 * 1024, 'yaml', 'YAML too large');
  const doc = parseDocument(text, {
    uniqueKeys: true,
    strict: true,
    customTags: [],
  });
  ensure(
    !doc.errors.length && !doc.warnings.length,
    'yaml',
    'Invalid YAML or unknown tag',
  );
  let count = 0;
  visit(doc, (_key, node, path) => {
    ensure(
      ++count < 10000 && path.length <= 32,
      'yaml',
      'YAML depth/node limit',
    );
    ensure(!isAlias(node), 'yaml', 'YAML aliases disabled');
    if (isCollection(node))
      ensure(node.items.length <= 1000, 'yaml', 'YAML collection too large');
  });
  return doc.toJS({ maxAliasCount: 0 });
}
