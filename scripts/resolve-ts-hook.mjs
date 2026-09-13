import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const asJs = new URL(specifier, context.parentURL)
    const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
      return next(asTs.href, context)
    }
  }
  return next(specifier, context)
}
