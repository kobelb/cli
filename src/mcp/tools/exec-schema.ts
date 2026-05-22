/**
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helper that builds the Zod input schema for an exec call.
 * Kept separate from exec.ts to avoid the dynamic import overhead on the hot path.
 */

import { z } from 'zod'
import type { RegistryEntry } from '../registry.ts'
import { loadEsApi } from '../../es/apis.ts'
import { loadKbApi } from '../../kb/apis.ts'
import { allCloudApis } from '../../cloud/apis.ts'
import { allServerlessApis } from '../../cloud/serverless-apis.ts'
import type { EsApiDefinition } from '../../es/types.ts'
import type { KbApiDefinition } from '../../kb/types.ts'
import type { CloudApiDefinition } from '../../cloud/types.ts'
import { resolveInput } from '../../es/types.ts'
import { buildCommandSchema as buildKbSchema } from '../../kb/register.ts'
import { buildCommandSchema as buildCloudSchema } from '../../cloud/register.ts'

/** Returns the Zod input schema for a registry entry. */
export async function getSchemaForEntry (entry: RegistryEntry): Promise<z.ZodObject<z.ZodRawShape>> {
  if (entry.surface === 'es') {
    const meta = {
      name: entry.esName!,
      namespace: entry.namespace,
      namespaceFile: entry.namespaceFile!,
      description: entry.description,
      method: entry.method as EsApiDefinition['method'],
      path: entry.path,
    }
    const def = await loadEsApi(meta)
    if (def.input == null) return z.looseObject({})
    return resolveInput(def.input)
  }

  if (entry.surface === 'kb') {
    const meta = {
      name: entry.esName!,
      namespace: entry.namespace!,
      namespaceFile: entry.namespaceFile!,
      description: entry.description,
      method: entry.method as KbApiDefinition['method'],
      path: entry.path,
    }
    const def = await loadKbApi(meta)
    return buildKbSchema(def)
  }

  // cloud
  const allDefs: CloudApiDefinition[] = [...allCloudApis, ...allServerlessApis]
  const def = allDefs.find(
    (d) => d.namespace === entry.cloudNamespace && d.name === entry.cloudName
  )
  if (def == null) {
    throw new Error(`Cloud definition not found: ${entry.cloudNamespace}/${entry.cloudName}`)
  }
  return buildCloudSchema(def)
}
