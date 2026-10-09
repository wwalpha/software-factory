import { verify } from 'node:crypto';
import type { ResultBundle } from '../domain/contracts.js';
import type { Tree } from '../domain/tree.js';
import { canonical, digest, treeDigest } from './artifacts.js';
import { ensure } from '../domain/invariants.js';
export function verifyBundle(
  bundle: ResultBundle,
  tree: Tree,
  publicKey: string,
): void {
  const { completionSignature, ...rest } = bundle;
  ensure(
    bundle.status === 'completed' &&
      completionSignature &&
      bundle.artifact?.digest === treeDigest(tree),
    'evidence',
    'Not a completed matching artifact',
  );
  ensure(
    verify(
      null,
      Buffer.from(canonical({ ...rest, completionSignature: null })),
      publicKey,
      Buffer.from(completionSignature, 'base64'),
    ),
    'evidence',
    'Completion signature invalid',
  );
  for (const receipt of bundle.checks) {
    const { signature, ...unsigned } = receipt;
    ensure(
      receipt.issuer === digest(publicKey) &&
        receipt.targetDigest === bundle.artifact.digest &&
        receipt.missionId === bundle.missionId &&
        receipt.result === 'pass' &&
        verify(
          null,
          Buffer.from(canonical(unsigned)),
          publicKey,
          Buffer.from(signature, 'base64'),
        ),
      'evidence',
      'Receipt invalid',
    );
  }
}
