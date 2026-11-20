const stub = new URL('./vendor/fetch-metadata-v2.2.0/actions-core-stub.js', import.meta.url).href

export async function resolve (specifier, context, nextResolve) {
  if (specifier === '@actions/core') {
    return { url: stub, shortCircuit: true }
  }
  // The vendored TypeScript imports './update_metadata' without an extension.
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}

export async function load (url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (url.endsWith('/output.ts') && loaded.source) {
    const source = loaded.source.toString().replace(
      /import\s+\{\s*updatedDependency\s*\}\s+from\s+['"]\.\/update_metadata['"];?\r?\n/,
      ''
    )
    return { ...loaded, source }
  }
  return loaded
}
