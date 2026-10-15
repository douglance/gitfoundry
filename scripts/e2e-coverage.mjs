import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

async function browserSources(root) {
  const sourceRoots = ['apps/web/src', 'packages/contracts/src'];
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(file);
    }
  }
  for (const sourceRoot of sourceRoots) await walk(join(root, sourceRoot));
  return files.sort();
}

export async function browserCoveragePlugin(root) {
  const { default: { createInstrumenter } } = await import('istanbul-lib-instrument');
  const files = await browserSources(root);
  const owned = new Set(files);
  const baseline = {};
  const instrument = (code, file) => {
    const instrumenter = createInstrumenter({
      esModules: true, parserPlugins: ['jsx'], produceSourceMap: true,
      coverageVariable: '__gfyE2eCoverage',
      coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false,
    });
    const filename = relative(root, file).split(sep).join('/');
    const output = instrumenter.instrumentSync(code, filename);
    return { code: output, map: instrumenter.lastSourceMap(), coverage: instrumenter.lastFileCoverage() };
  };
  for (const file of files) {
    const result = instrument(await readFile(file, 'utf8'), file);
    baseline[result.coverage.path] = result.coverage;
  }
  const baselinePath = join(root, 'artifacts/e2e-coverage/web-baseline.json');
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, JSON.stringify(baseline));
  return {
    name: 'gitfoundry-browser-e2e-coverage', enforce: 'pre',
    transform(code, id) {
      const file = resolve(id.split('?')[0]);
      if (!owned.has(file)) return null;
      const result = instrument(code, file);
      return { code: result.code, map: result.map };
    },
  };
}

export async function browserCoverageSession(root, outDir) {
  if (process.env.GFY_E2E_COVERAGE !== '1') return { async capture() {}, async report() { return undefined; } };
  const { default: { createCoverageMap } } = await import('istanbul-lib-coverage');
  const baseline = JSON.parse(await readFile(join(root, 'artifacts/e2e-coverage/web-baseline.json'), 'utf8'));
  const map = createCoverageMap(baseline);
  const expected = Object.keys(baseline).sort();
  if (!expected.length) throw new Error('Browser coverage denominator is empty');
  let captures = 0;
  return {
    async capture(evaluate) {
      const actual = await evaluate('globalThis.__gfyE2eCoverage || {}');
      const paths = Object.keys(actual);
      if (paths.some(file => !expected.includes(file))) throw new Error('Browser coverage contains an unowned source file');
      if (paths.length) { map.merge(actual); captures += 1; }
    },
    async report() {
      if (!captures) throw new Error('Browser workflows produced no instrumented source coverage');
      const uncovered = map.files().sort().map(file => {
        const coverage = map.fileCoverageFor(file);
        const data = coverage.data;
        return {
          file,
          statements: Object.entries(data.s).filter(([, count]) => count === 0).map(([id]) => data.statementMap[id].start.line),
          branches: Object.entries(data.b).flatMap(([id, counts]) => counts.flatMap((count, arm) => count === 0 ? [{ line: data.branchMap[id].line, arm }] : [])),
          functions: Object.entries(data.f).filter(([, count]) => count === 0).map(([id]) => data.fnMap[id].name),
        };
      });
      const summary = { scope: 'frontend and shared contract JavaScript/JSX source modules', files: expected.length, captures, metrics: map.getCoverageSummary().data, uncovered };
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'coverage-final.json'), JSON.stringify(map.toJSON()));
      await writeFile(join(outDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
      if (process.env.GFY_E2E_REQUIRE_100 === '1' && ['statements', 'branches', 'functions', 'lines'].some(metric => summary.metrics[metric].pct !== 100)) {
        throw new Error('Frontend E2E coverage is below 100%; see coverage-summary.json');
      }
      return { files: summary.files, captures, metrics: summary.metrics };
    },
  };
}
