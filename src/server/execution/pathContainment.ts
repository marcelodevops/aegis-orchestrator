/**
 * Aegis Orchestrator - Robust Path Containment & Traversal Defense
 * 
 * Guarantees that all worker, workspace, artifact, and delivery operations
 * remain strictly contained within approved directory boundaries.
 * 
 * Defends against:
 * 1. Prefix collisions (e.g., /tmp/project vs /tmp/project-other)
 * 2. Symlink escapes via canonical realpath resolution
 * 3. Null-byte injections and path normalization bypasses
 */

import path from 'path';
import fs from 'fs';

export interface PathValidationResult {
  valid: boolean;
  resolvedPath: string;
  error?: string;
}

/**
 * Validates that candidatePath is strictly inside or equal to baseDir.
 * If the path (or parent) exists on disk, resolves symlinks with fs.realpathSync.
 */
export function assertPathContained(candidatePath: string, baseDir: string): PathValidationResult {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return { valid: false, resolvedPath: '', error: 'Candidate path is empty or invalid' };
  }
  if (!baseDir || typeof baseDir !== 'string') {
    return { valid: false, resolvedPath: '', error: 'Base directory is empty or invalid' };
  }

  // Reject null bytes immediately
  if (candidatePath.includes('\0') || baseDir.includes('\0')) {
    return { valid: false, resolvedPath: '', error: 'Null bytes detected in path' };
  }

  // Resolve absolute paths lexically first
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, candidatePath);

  // Lexical containment check with trailing separator
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  const isLexicallyContained = resolvedTarget === resolvedBase || resolvedTarget.startsWith(baseWithSep);

  if (!isLexicallyContained) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Path traversal detected: '${resolvedTarget}' escapes base directory '${resolvedBase}'`,
    };
  }

  // Symlink resolution check
  try {
    const canonicalBase = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;
    const canonicalBaseWithSep = canonicalBase.endsWith(path.sep) ? canonicalBase : canonicalBase + path.sep;

    // If target exists, resolve its real path
    if (fs.existsSync(resolvedTarget)) {
      const canonicalTarget = fs.realpathSync(resolvedTarget);
      const isRealContained = canonicalTarget === canonicalBase || canonicalTarget.startsWith(canonicalBaseWithSep);
      if (!isRealContained) {
        return {
          valid: false,
          resolvedPath: canonicalTarget,
          error: `Symlink traversal detected: '${canonicalTarget}' resolves outside base '${canonicalBase}'`,
        };
      }
      return { valid: true, resolvedPath: canonicalTarget };
    }

    // If target doesn't exist yet (e.g. creating new file), check its closest existing ancestor
    let current = path.dirname(resolvedTarget);
    while (current.length >= resolvedBase.length) {
      if (fs.existsSync(current)) {
        const canonicalAncestor = fs.realpathSync(current);
        const isAncestorContained = canonicalAncestor === canonicalBase || canonicalAncestor.startsWith(canonicalBaseWithSep);
        if (!isAncestorContained) {
          return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Ancestor symlink escape: '${canonicalAncestor}' resolves outside base '${canonicalBase}'`,
          };
        }
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (err: any) {
    return { valid: false, resolvedPath: resolvedTarget, error: `Filesystem resolution error: ${err.message}` };
  }

  return { valid: true, resolvedPath: resolvedTarget };
}

/**
 * Sanitizes task keys or artifact names to safe filename characters only.
 */
export function sanitizeKeyForPath(rawKey: string): string {
  if (!rawKey) return 'unknown';
  // Allow alphanumeric, hyphen, underscore
  return rawKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}
