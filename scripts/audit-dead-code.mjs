/* eslint-disable no-console, no-undef -- standalone Node.js repository audit script */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const projectRoot = process.cwd();
const sourceRoot = join(projectRoot, "src");
const extensions = [".ts", ".tsx"];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const productionFiles = walk(sourceRoot)
  .filter((file) => extensions.includes(extname(file)))
  .filter((file) => !relative(sourceRoot, file).replace(/\\/g, "/").startsWith("__tests__/"))
  .filter((file) => !relative(sourceRoot, file).replace(/\\/g, "/").startsWith("eval/"))
  .filter((file) => !file.endsWith(".d.ts"));
const productionSet = new Set(productionFiles.map((file) => resolve(file)));

const contractRoots = new Set([
  // Next.js route modules cannot export these schemas directly; tests consume the registry.
  resolve(sourceRoot, "config/api-route-contracts.ts"),
]);
const roots = productionFiles.filter((file) => {
  const normalized = relative(projectRoot, file).replace(/\\/g, "/");
  return (
    /^src\/app\/.+\/(?:page|route|layout)\.tsx?$/.test(normalized) ||
    /^src\/app\/(?:page|route|layout)\.tsx?$/.test(normalized) ||
    normalized === "src/instrumentation.ts" ||
    normalized === "src/middleware.ts" ||
    contractRoots.has(resolve(file))
  );
});

function importedSpecifiers(file) {
  const source = readFileSync(file, "utf-8");
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveLocalImport(importer, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else return null;

  for (const candidate of [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => join(base, `index${extension}`)),
  ]) {
    const resolved = resolve(candidate);
    if (existsSync(resolved) && productionSet.has(resolved)) return resolved;
  }
  return null;
}

const reachable = new Set();
const queue = [...roots];
while (queue.length > 0) {
  const file = resolve(queue.shift());
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const specifier of importedSpecifiers(file)) {
    const imported = resolveLocalImport(file, specifier);
    if (imported && !reachable.has(imported)) queue.push(imported);
  }
}

const unreachable = productionFiles
  .map((file) => resolve(file))
  .filter((file) => !reachable.has(file))
  .map((file) => relative(projectRoot, file).replace(/\\/g, "/"))
  .sort();

if (unreachable.length > 0) {
  console.error(`发现 ${unreachable.length} 个不可达生产模块：`);
  for (const file of unreachable) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`死代码审计通过：${productionFiles.length} 个生产模块均可从运行时入口到达。`);
}
