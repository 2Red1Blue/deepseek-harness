/**
 * Required external Session-event registration and read-validation helpers.
 * @module @deepseek-ai/dsh-session/external-events
 */

import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'
import type {
  RequiredExternalSessionEventDefinition,
  RequiredExternalSessionEventRef,
  RequiredExternalSessionEventRegistration,
  RequiredExternalSessionEventValidation,
  RequiredExternalSessionEventValidationResult,
} from './types.ts'

interface RegisteredEventDefinition {
  readonly ref: RequiredExternalSessionEventRef
  readonly type: string
  readonly validate: (data: unknown) => void
}

/** Return a stable key for one persisted external event identity. */
function keyOf(ref: RequiredExternalSessionEventRef, type: string): string {
  return JSON.stringify([ref.namespace, ref.version, type])
}

/** Reject an invalid registration namespace before it affects a durable log. */
function assertNamespace(namespace: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(namespace)) {
    throw new TypeError(`required external Session event namespace "${namespace}" is invalid`)
  }
}

/**
 * Validate one persisted external-reader reference.
 * @param value - decoded envelope value, or absent when the event is not external.
 * @returns a validated identity, or `undefined` when the marker is absent.
 * @throws {TypeError} when a present marker cannot identify one external reader vocabulary.
 */
export function requiredExternalSessionEventRef(value: unknown): RequiredExternalSessionEventRef | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('required external Session event reference must be a plain record')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'namespace') || !Object.hasOwn(record, 'version')) {
    throw new TypeError('required external Session event reference has invalid fields')
  }
  if (typeof record.namespace !== 'string') {
    throw new TypeError('required external Session event reference namespace must be a string')
  }
  assertNamespace(record.namespace)
  const version = record.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('required external Session event reference version must be a positive safe integer')
  }
  return { namespace: record.namespace, version }
}

/**
 * Owns the current external required-event vocabulary for one SessionStore.
 * Registrations are lifecycle effects; callers must return the supplied
 * disposer from the owning plugin effect.
 */
export class RequiredExternalSessionEventRegistry {
  private generationValue = 0
  private readonly definitions = new Map<string, RegisteredEventDefinition>()
  private readonly writableByType = new Map<string, RegisteredEventDefinition>()
  private snapshotValue: RequiredExternalSessionEventValidation | undefined

  /**
   * Register one exact external vocabulary version.
   * @param registration - namespace, version, event types, and payload validators to own.
   * @returns an idempotent disposer that removes the registered vocabulary.
   * @throws {TypeError} when the registration cannot identify one valid external vocabulary.
   * @throws {Error} when another active registration already owns one of its types.
   */
  register(registration: RequiredExternalSessionEventRegistration): () => void {
    assertNamespace(registration.namespace)
    if (!Number.isSafeInteger(registration.version) || registration.version < 1) {
      throw new TypeError('required external Session event registration version must be a positive safe integer')
    }
    if (!Array.isArray(registration.events) || registration.events.length === 0) {
      throw new TypeError('required external Session event registration must declare at least one event')
    }
    const ref = Object.freeze({ namespace: registration.namespace, version: registration.version })
    const definitions: RegisteredEventDefinition[] = []
    const seen = new Set<string>()
    for (const candidate of registration.events) {
      const definition = candidate as RequiredExternalSessionEventDefinition
      if (typeof definition?.type !== 'string' || !definition.type.startsWith(`${ref.namespace}/`)) {
        throw new TypeError(`required external Session event type must begin with "${ref.namespace}/"`)
      }
      if (typeof definition.validate !== 'function') {
        throw new TypeError(`required external Session event "${definition.type}" validator must be a function`)
      }
      if (KNOWN_SESSION_EVENT_TYPES.has(definition.type)) {
        throw new TypeError(`required external Session event "${definition.type}" is already owned by Harness`)
      }
      const key = keyOf(ref, definition.type)
      if (seen.has(key) || this.definitions.has(key) || this.writableByType.has(definition.type)) {
        throw new Error(`required external Session event "${definition.type}" is already registered`)
      }
      seen.add(key)
      definitions.push(Object.freeze({ ref, type: definition.type, validate: definition.validate }))
    }
    const vocabulary = Object.freeze({ definitions: Object.freeze(definitions) })
    for (const definition of definitions) {
      this.definitions.set(keyOf(ref, definition.type), definition)
      this.writableByType.set(definition.type, definition)
    }
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const definition of vocabulary.definitions) {
        this.definitions.delete(keyOf(definition.ref, definition.type))
        this.writableByType.delete(definition.type)
      }
      this.changed()
    }
  }

  /**
   * Validate and resolve one writable event type through the current registration set.
   * @param type - external event type the caller intends to append.
   * @param data - detached payload that the active registration validates.
   * @returns the immutable reader identity to stamp on the event.
   * @throws {Error} when no active registration owns the type or rejects its payload.
   */
  resolve(type: string, data: unknown): RequiredExternalSessionEventRef {
    const definition = this.writableByType.get(type)
    if (definition === undefined) {
      throw new Error(`required external Session event "${type}" is not registered`)
    }
    definition.validate(data)
    return definition.ref
  }

  /**
   * Capture the reader vocabulary that one persistence operation must use consistently.
   * @returns an immutable validation snapshot whose identity changes after a registration mutation.
   */
  snapshot(): RequiredExternalSessionEventValidation {
    return this.snapshotValue ??= this.createSnapshot()
  }

  /** Record one vocabulary mutation before a future storage read snapshots it. */
  private changed(): void {
    this.generationValue += 1
    this.snapshotValue = undefined
  }

  /** Materialize the immutable reader vocabulary for the current generation. */
  private createSnapshot(): RequiredExternalSessionEventValidation {
    const definitions = new Map(this.definitions)
    const generation = this.generationValue
    return Object.freeze({
      generation,
      validate: (ref: RequiredExternalSessionEventRef, type: string, data: unknown): RequiredExternalSessionEventValidationResult => {
        const definition = definitions.get(keyOf(ref, type))
        if (definition === undefined) {
          return {
            kind: 'unavailable',
            reason: `no registration for ${ref.namespace} v${String(ref.version)} event "${type}"`,
          }
        }
        try {
          definition.validate(data)
          return { kind: 'valid' }
        } catch (error: unknown) {
          return {
            kind: 'invalid',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      },
    })
  }
}
