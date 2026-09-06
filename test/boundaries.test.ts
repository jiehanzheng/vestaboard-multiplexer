import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(/\.tsx?$/.test(path) ? [path] : []);
  }))).flat();
}

async function imports(file: string): Promise<string[]> {
  return ts.preProcessFile(await readFile(file, "utf8")).importedFiles.map((entry) => entry.fileName);
}

test("plugins do not import another plugin's implementation", async () => {
  const root = resolve("src/plugins");
  for (const file of await sourceFiles(root)) {
    const owner = relative(root, file).split("/")[0].replace(/\.ts$/, "");
    for (const specifier of await imports(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const path = relative(root, target);
      if (path.startsWith("..")) continue;
      const dependency = path.split("/")[0].replace(/\.[jt]s$/, "");
      assert.equal(dependency, owner, `${relative(root, file)} imports another plugin: ${specifier}`);
    }
  }
});

test("shared browser contracts do not reach server implementations", async () => {
  const visited = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of await imports(file)) {
      assert.ok(!specifier.startsWith("node:"), `${file} imports ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      assert.match(target, /\/(contracts\/|[^/]+\/config\.ts$|vestaboardCharacters\.ts$)/, `Contract imports server implementation: ${target}`);
      await visit(target);
    }
  }
  for (const file of await sourceFiles(resolve("src/contracts"))) await visit(file);
});

test("browser code imports only browser-safe backend contracts", async () => {
  const root = resolve("web/src");
  for (const file of await sourceFiles(root)) {
    for (const specifier of await imports(file)) {
      assert.ok(!specifier.startsWith("node:"), `${file} imports ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (!relative(root, target).startsWith("..")) continue;
      assert.ok(target.startsWith(`${resolve("src/contracts")}/`), `Browser imports server implementation: ${target}`);
    }
  }
});
