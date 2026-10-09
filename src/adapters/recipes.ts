import { readFileSync } from 'node:fs';
import { contract } from './contracts.js';
import { digest } from './artifacts.js';
import { ensure } from '../domain/invariants.js';
import type { RoleRecipe } from '../domain/contracts.js';
export function recipes(): RoleRecipe[] {
  const values: unknown = JSON.parse(
    readFileSync(
      new URL('../../../config/roles.json', import.meta.url),
      'utf8',
    ),
  );
  ensure(Array.isArray(values), 'recipe', 'Role recipe list required');
  return values.map((value) => {
    const recipe = contract('RoleRecipe', value);
    ensure(
      recipe.promptDigest === digest(recipe.prompt),
      'recipe',
      'Prompt digest mismatch',
    );
    ensure(
      recipe.role === 'builder' ||
        !recipe.capabilities.includes('edit-candidate'),
      'recipe',
      'Non-builder role cannot edit product',
    );
    return recipe;
  });
}
