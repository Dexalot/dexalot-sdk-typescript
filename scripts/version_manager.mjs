#!/usr/bin/env node
/**
 * Version management script.
 *
 * Syncs version across VERSION file, package.json, and any src/ tree .ts files
 * that contain `export const version = '...'` (single or double quotes).
 *
 * Commands:
 *   get       Print the current version from VERSION
 *   set       Set a specific version across all files
 *   bump      Bump major / minor / patch
 *   validate  Check all files are in sync
 *   info      Show per-file version breakdown
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Relative path from project root, then regex with exactly one capture group for the version. */
const STATIC_TARGET_DEFS = [['package.json', /^  "version": "([^"]+)"/m]];

const VERSION_EXPORT_PATTERN = /export const version = ['"]([^'"]+)['"]/;

function walkTsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function discoverTargets() {
  /** @type {Array<[string, RegExp]>} */
  const targets = STATIC_TARGET_DEFS.map(([rel, re]) => [join(PROJECT_ROOT, rel), re]);
  const srcDir = join(PROJECT_ROOT, 'src');
  for (const file of walkTsFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    if (VERSION_EXPORT_PATTERN.test(text)) {
      targets.push([file, new RegExp(VERSION_EXPORT_PATTERN.source)]);
    }
    VERSION_EXPORT_PATTERN.lastIndex = 0;
  }
  targets.sort((a, b) => a[0].localeCompare(b[0]));
  return targets;
}

function valid(version) {
  return SEMVER.test(version);
}

function parseVersion(version) {
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10));
  return { major, minor, patch };
}

class VersionManager {
  constructor() {
    this.versionFile = join(PROJECT_ROOT, 'VERSION');
    this.targets = discoverTargets();
  }

  get() {
    if (!existsSync(this.versionFile)) {
      throw new Error(`VERSION file not found: ${this.versionFile}`);
    }
    const v = readFileSync(this.versionFile, 'utf8').trim();
    if (!valid(v)) {
      throw new Error(`Invalid version in VERSION file: ${JSON.stringify(v)}`);
    }
    return v;
  }

  /**
   * @param {string} path
   * @param {RegExp} pattern
   * @returns {string | null}
   */
  readFileVersion(path, pattern) {
    const text = readFileSync(path, 'utf8');
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    return m ? m[1] : null;
  }

  /**
   * @param {string} newVersion
   */
  set(newVersion) {
    if (!valid(newVersion)) {
      throw new Error(`Invalid version format: ${JSON.stringify(newVersion)}`);
    }

    writeFileSync(this.versionFile, `${newVersion}\n`);
    console.log(`  VERSION  -> ${newVersion}`);

    for (const [path, pattern] of this.targets) {
      if (!existsSync(path)) {
        console.log(`  WARNING  ${relative(PROJECT_ROOT, path)}: file not found, skipping`);
        continue;
      }
      const original = readFileSync(path, 'utf8');
      pattern.lastIndex = 0;
      const updated = original.replace(pattern, (full, captured) => full.replace(captured, newVersion));
      const rel = relative(PROJECT_ROOT, path);
      if (updated !== original) {
        writeFileSync(path, updated);
        console.log(`  updated  ${rel}`);
      } else {
        console.log(`  no-op    ${rel}`);
      }
    }
  }

  /**
   * @param {'major' | 'minor' | 'patch'} part
   */
  bump(part) {
    const { major, minor, patch } = parseVersion(this.get());
    switch (part) {
      case 'major':
        return `${major + 1}.0.0`;
      case 'minor':
        return `${major}.${minor + 1}.0`;
      case 'patch':
        return `${major}.${minor}.${patch + 1}`;
      default:
        throw new Error(`Unknown bump type: ${JSON.stringify(part)}`);
    }
  }

  validate() {
    const expected = this.get();
    console.log(`Expected version: ${expected}`);
    let ok = true;
    for (const [path, pattern] of this.targets) {
      const rel = relative(PROJECT_ROOT, path);
      if (!existsSync(path)) {
        console.log(`  WARNING  ${rel}: not found`);
        continue;
      }
      const found = this.readFileVersion(path, pattern);
      if (found === expected) {
        console.log(`  OK       ${rel}: ${found}`);
      } else {
        const label = found ?? '<not found>';
        console.log(`  MISMATCH ${rel}: ${label} (expected ${expected})`);
        ok = false;
      }
    }
    return ok;
  }

  info() {
    const current = this.get();
    const { major, minor, patch } = parseVersion(current);
    console.log(`VERSION file : ${current}  (major=${major} minor=${minor} patch=${patch})`);
    console.log('Tracked files:');
    for (const [path, pattern] of this.targets) {
      const rel = relative(PROJECT_ROOT, path);
      let found;
      if (existsSync(path)) {
        found = this.readFileVersion(path, pattern) ?? '<not found>';
      } else {
        found = '<file missing>';
      }
      console.log(`  ${rel}: ${found}`);
    }
  }
}

function printHelp() {
  console.log(`Usage: node scripts/version_manager.mjs <command> [options]

Commands:
  get                    Print current version from VERSION
  set <version>          Set version everywhere
  bump [major|minor|patch]   Bump semver (default: patch)
  validate               Check VERSION, package.json, and src version exports match
  info                   Show per-file versions

Options:
  --dry-run              For set/bump: print intent without writing
`);
}

function main() {
  const argv = process.argv.slice(2);
  const dryRunIdx = argv.indexOf('--dry-run');
  const dryRun = dryRunIdx !== -1;
  if (dryRun) argv.splice(dryRunIdx, 1);

  const command = argv[0];
  if (!command) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  try {
    const mgr = new VersionManager();

    switch (command) {
      case 'get':
        console.log(mgr.get());
        break;

      case 'set': {
        const version = argv[1];
        if (!version) {
          console.error('Error: set requires a version argument');
          process.exitCode = 1;
          return;
        }
        if (!valid(version)) {
          console.error(`Error: invalid version format: ${JSON.stringify(version)}`);
          process.exitCode = 1;
          return;
        }
        if (dryRun) {
          console.log(`Would set version to ${version} (dry-run)`);
        } else {
          mgr.set(version);
          console.log(`Version set to ${version}`);
        }
        break;
      }

      case 'bump': {
        const part = /** @type {'major' | 'minor' | 'patch'} */ (argv[1] ?? 'patch');
        if (!['major', 'minor', 'patch'].includes(part)) {
          console.error(`Error: bump part must be major, minor, or patch, got ${JSON.stringify(part)}`);
          process.exitCode = 1;
          return;
        }
        const newVersion = mgr.bump(part);
        const current = mgr.get();
        if (dryRun) {
          console.log(`Would bump ${part}: ${current} -> ${newVersion} (dry-run)`);
        } else {
          console.log(`Bumping ${part}: ${current} -> ${newVersion}`);
          mgr.set(newVersion);
        }
        break;
      }

      case 'validate':
        if (mgr.validate()) {
          console.log('All versions are in sync.');
        } else {
          console.error('Version mismatch detected.');
          process.exitCode = 1;
        }
        break;

      case 'info':
        mgr.info();
        break;

      default:
        console.error(`Unknown command: ${JSON.stringify(command)}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (exc) {
    console.error(`Error: ${exc instanceof Error ? exc.message : String(exc)}`);
    process.exitCode = 1;
  }
}

main();
