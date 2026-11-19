/** Verify the 0.34 maintenance package against the published Cloud SDK. Run in CI. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!pkg.version.startsWith("0.34.")) throw new Error("This check belongs to the 0.34 maintenance line.");
const registry = process.argv.includes("--registry");
const directory = await mkdtemp(join(tmpdir(), "stdlib-cloud-074-"));
async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await process.exited !== 0) throw new Error(`Consumer command failed: ${command.join(" ")}`);
}
try {
  // New registry versions can lag behind a successful publish by several minutes.
  if (registry) {
    let available = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`https://registry.npmjs.org/@k2b%2Fstdlib/${pkg.version}`, { cache: "no-store" });
      if (response.ok) { available = true; break; }
      if (response.status !== 404) throw new Error(`Registry returned HTTP ${response.status}`);
      console.log(`Waiting for registry propagation of ${pkg.version} (${attempt + 1}/20)`);
      await Bun.sleep(30_000);
    }
    if (!available) throw new Error("Published version did not propagate within 10 minutes");
  }
  let dependency = pkg.version;
  if (!registry) {
    await run(["npm", "pack", "--silent", "--pack-destination", directory], root);
    dependency = `file:${join(directory, `k2b-stdlib-${pkg.version}.tgz`)}`;
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: {
      "@k2b/cloud": "0.74.1", "@k2b/stdlib": dependency,
      zod: "4.4.3", ibantools: "4.5.4", saxes: "6.0.0", "libxml2-wasm": "0.6.0",
      "pdf-lib": "1.17.1", "solid-js": "1.9.10", "lean-qr": "2.0.0",
    },
    devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.4" },
  }));
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, skipLibCheck: true, target: "ESNext", module: "ESNext",
      moduleResolution: "bundler", allowImportingTsExtensions: true,
      jsx: "preserve", jsxImportSource: "solid-js", types: ["bun"],
    }, include: ["consumer.ts", "node_modules/@k2b/cloud/src/types/ambient.d.ts"],
  }));
  await writeFile(join(directory, "consumer.ts"), `
import { fail, err, type Result, type ServiceError } from "@k2b/stdlib";
import type { CapabilityError, CapabilityInvocationResult } from "@k2b/cloud/contracts/capabilities";
import type { DatevPosting, DatevXmlDocumentImage } from "@k2b/stdlib/finance";
export function capabilityFailure(error: ServiceError): CapabilityInvocationResult<never> {
  const capabilityError: CapabilityError = error;
  return { ok: false, error: capabilityError };
}
export function serviceFailure(result: Result<string>): CapabilityInvocationResult<never> {
  if (result.ok) throw new Error("Failure fixture only");
  return { ok: false, error: result.error };
}
const guid = "E0A08953-FBAA-4054-AF36-993D5D68F040";
const image: DatevXmlDocumentImage = {kind:"documentImage", guid, files:[{name:"receipt.pdf", bytes:new Uint8Array([1])}]};
const row: DatevPosting = {amount:"119.00", direction:"S", account:"8400", counterAccount:"10000", documentDate:"2026-11-02", documentNumber:"RE-1", documentGuid:guid};
export const inputs = {image, row};
const failure = fail(err.badInput("Expected"));
if (failure.ok || capabilityFailure(failure.error).ok) throw new Error("Lost failure");
for (const suffix of ["", "/browser", "/solid", "/qr", "/bun", "/finance", "/finance/validate"]) await import("@k2b/stdlib" + suffix);
console.log("ServiceError -> CapabilityError without casts; DATEV types; all seven entrypoints: PASS");
`);
  await run(["bun", "install", "--no-cache", "--registry=https://registry.npmjs.org"], directory);
  await run(["bun", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], directory);
  await run(["bun", "consumer.ts"], directory);
  const installed = JSON.parse(await readFile(join(directory, "node_modules/@k2b/stdlib/package.json"), "utf8"));
  if (installed.version !== pkg.version) throw new Error("Wrong consumer stdlib version");
  console.log(`Fresh consumer: Cloud SDK 0.74.1 + stdlib ${installed.version} (${registry ? "npm registry" : "packed source"}): PASS`);
} finally {
  await rm(directory, { recursive: true, force: true });
  console.log(`Removed temporary consumer: ${directory}`);
}
