// ts7-compare-jsii: structural diff of the type space of two .jsii assemblies.
//
// Used as the parity gate for the experimental ts7 backend: build a package
// with the default backend and with JSII_COMPILER_BACKEND=ts7, then diff.
// Compared per type: kind, base, interfaces, abstract/datatype flags, symbolId,
// enum member names, and every property/method/initializer signature including
// parameter documentation and the stability/deprecated/default doc tags.
// Not compared: assembly header fields, locationInModule, and free-text member
// summaries/remarks (see normMember below).
// Usage: node ts7-compare-jsii.mjs <reference.jsii> <generated.jsii>
import * as fs from 'node:fs';

const ref = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const gen = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const report = { matchedTypes: 0, missingTypes: [], extraTypes: [], memberDiffs: [], fieldDiffs: [], membersTotal: 0, membersMatched: 0 };

const refTypes = ref.types ?? {};
const genTypes = gen.types ?? {};

for (const fqn of Object.keys(refTypes)) if (!genTypes[fqn]) report.missingTypes.push(fqn);
for (const fqn of Object.keys(genTypes)) if (!refTypes[fqn]) report.extraTypes.push(fqn);

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object' && x.union && Array.isArray(x.union.types)) {
    // union member order is semantically insignificant; normalize for comparison
    const types = x.union.types.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'union').map(([k, v]) => [k, canon(v)])), union: { types } };
  }
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = canon(x[k]);
    return o;
  }
  return x;
}

function normMember(m) {
  const c = JSON.parse(JSON.stringify(m));
  delete c.locationInModule;
  delete c.overrides;
  if (c.docs) {
    // compare only presence of summary and key tags
    c.docs = Object.fromEntries(Object.entries(c.docs).filter(([k]) => ['default', 'deprecated', 'stability'].includes(k)));
    if (!Object.keys(c.docs).length) delete c.docs;
  }
  return c;
}

function diffMembers(fqn, kind, refList = [], genList = []) {
  const refMap = new Map(refList.map((m) => [m.name, m]));
  const genMap = new Map(genList.map((m) => [m.name, m]));
  for (const [name, rm] of refMap) {
    report.membersTotal++;
    const gm = genMap.get(name);
    if (!gm) { report.memberDiffs.push(`${fqn} ${kind} ${name}: MISSING in generated`); continue; }
    const a = JSON.stringify(canon(normMember(rm)));
    const b = JSON.stringify(canon(normMember(gm)));
    if (a !== b) report.memberDiffs.push(`${fqn} ${kind} ${name}: DIFFER\n  ref: ${a}\n  gen: ${b}`);
    else report.membersMatched++;
  }
  for (const name of genMap.keys()) {
    if (!refMap.has(name)) report.memberDiffs.push(`${fqn} ${kind} ${name}: EXTRA in generated`);
  }
}

for (const [fqn, rt] of Object.entries(refTypes)) {
  const gt = genTypes[fqn];
  if (!gt) continue;
  report.matchedTypes++;
  for (const field of ['kind', 'base', 'abstract', 'datatype', 'symbolId']) {
    const a = JSON.stringify(rt[field]);
    const b = JSON.stringify(gt[field]);
    if (a !== b) report.fieldDiffs.push(`${fqn}.${field}: ref=${a} gen=${b}`);
  }
  const ri = JSON.stringify((rt.interfaces ?? []).slice().sort());
  const gi = JSON.stringify((gt.interfaces ?? []).slice().sort());
  if (ri !== gi) report.fieldDiffs.push(`${fqn}.interfaces: ref=${ri} gen=${gi}`);
  diffMembers(fqn, 'prop', rt.properties, gt.properties);
  diffMembers(fqn, 'method', rt.methods, gt.methods);
  if (rt.kind === 'enum') {
    const rm = JSON.stringify((rt.members ?? []).map((m) => m.name).sort());
    const gm = JSON.stringify((gt.members ?? []).map((m) => m.name).sort());
    if (rm !== gm) report.fieldDiffs.push(`${fqn}.members: ref=${rm} gen=${gm}`);
  }
  if (rt.initializer || gt.initializer) {
    diffMembers(fqn, 'initializer', rt.initializer ? [{ ...rt.initializer, name: '<init>' }] : [], gt.initializer ? [{ ...gt.initializer, name: '<init>' }] : []);
  }
}

const MAX = Number(process.env.MAX_DIFFS ?? 30);
console.log(`=== compare summary ===`);
console.log(`types: ref=${Object.keys(refTypes).length} gen=${Object.keys(genTypes).length} matched=${report.matchedTypes}`);
console.log(`missing: ${report.missingTypes.length} ${JSON.stringify(report.missingTypes.slice(0, 20))}`);
console.log(`extra:   ${report.extraTypes.length} ${JSON.stringify(report.extraTypes.slice(0, 20))}`);
console.log(`members: ${report.membersMatched}/${report.membersTotal} identical (${(report.membersMatched / Math.max(1, report.membersTotal) * 100).toFixed(1)}%)`);
console.log(`field diffs: ${report.fieldDiffs.length}`);
for (const d of report.fieldDiffs.slice(0, MAX)) console.log(`  - ${d}`);
console.log(`member diffs: ${report.memberDiffs.length}`);
for (const d of report.memberDiffs.slice(0, MAX)) console.log(`  - ${d}`);
