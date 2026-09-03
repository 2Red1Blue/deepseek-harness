import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { RequiredExternalSessionEventRegistration, SessionEvent } from '@deepseek-ai/dsh-session'

const registration: RequiredExternalSessionEventRegistration = {
  namespace: 'roundtable-director',
  version: 1,
  events: [{
    type: 'roundtable-director/run',
    validate(data: unknown): void {
      if (typeof data !== 'object' || data === null || (data as Record<string, unknown>)['runId'] !== 'run-1') {
        throw new Error('run event requires runId "run-1"')
      }
    },
  }],
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

describe('SessionStore required external events', () => {
  it('stamps a registered event after validating its detached payload', async () => {
    const ctx = await setup()
    const dispose = ctx.sessions.registerRequiredExternalEvents(registration)
    const session = ctx.sessions.create(SessionId('external-writer'))

    const event = ctx.sessions.appendRequiredExternalEvent(
      session,
      'roundtable-director/run',
      { runId: 'run-1' },
    )

    expect(event).toMatchObject({
      type: 'roundtable-director/run',
      data: { runId: 'run-1' },
      requiredExternal: { namespace: 'roundtable-director', version: 1 },
    })
    expect(event.ignorable).toBeUndefined()
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    dispose()
  })

  it('refuses unregistered, invalid, disposed, and detached external appends before mutation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('external-refusal'))

    expect(() => ctx.sessions.appendRequiredExternalEvent(session, 'roundtable-director/run', { runId: 'run-1' }))
      .toThrow('not registered')
    expect(session.snapshotEvents()).toEqual([])

    const dispose = ctx.sessions.registerRequiredExternalEvents(registration)
    expect(() => ctx.sessions.appendRequiredExternalEvent(session, 'roundtable-director/run', { runId: 'wrong' }))
      .toThrow('requires runId')
    expect(session.snapshotEvents()).toEqual([])

    dispose()
    expect(() => ctx.sessions.appendRequiredExternalEvent(session, 'roundtable-director/run', { runId: 'run-1' }))
      .toThrow('not registered')
    expect(session.snapshotEvents()).toEqual([])

    const secondDispose = ctx.sessions.registerRequiredExternalEvents(registration)
    const detached = ctx.sessions.prepare(SessionId('external-detached'))
    expect(() => ctx.sessions.appendRequiredExternalEvent(detached, 'roundtable-director/run', { runId: 'run-1' }))
      .toThrow('not live in this store')
    secondDispose()
  })

  it('changes the reusable reader snapshot whenever a registration enters or leaves', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.requiredExternalEventValidation()
    const dispose = ctx.sessions.registerRequiredExternalEvents(registration)
    const active = ctx.sessions.requiredExternalEventValidation()

    expect(active).not.toBe(absent)
    expect(active.validate({ namespace: 'roundtable-director', version: 1 }, 'roundtable-director/run', { runId: 'run-1' }))
      .toEqual({ kind: 'valid' })

    dispose()
    const removed = ctx.sessions.requiredExternalEventValidation()
    expect(removed).not.toBe(active)
    expect(removed.validate({ namespace: 'roundtable-director', version: 1 }, 'roundtable-director/run', { runId: 'run-1' }))
      .toMatchObject({ kind: 'unavailable' })
  })

  it('requires an exact namespace, version, and type on cold-read validation', async () => {
    const ctx = await setup()
    const dispose = ctx.sessions.registerRequiredExternalEvents(registration)
    const snapshot = ctx.sessions.requiredExternalEventValidation()

    expect(snapshot.validate({ namespace: 'other-plugin', version: 1 }, 'roundtable-director/run', { runId: 'run-1' }))
      .toMatchObject({ kind: 'unavailable' })
    expect(snapshot.validate({ namespace: 'roundtable-director', version: 2 }, 'roundtable-director/run', { runId: 'run-1' }))
      .toMatchObject({ kind: 'unavailable' })
    expect(snapshot.validate({ namespace: 'roundtable-director', version: 1 }, 'roundtable-director/other', { runId: 'run-1' }))
      .toMatchObject({ kind: 'unavailable' })
    dispose()
  })

  it('rejects malformed, duplicate, and asynchronous registrations without retaining ownership', async () => {
    const ctx = await setup()
    const invalidNamespace = { ...registration, namespace: 1 } as unknown as RequiredExternalSessionEventRegistration
    expect(() => ctx.sessions.registerRequiredExternalEvents(invalidNamespace))
      .toThrow('namespace must be a string')

    const first = ctx.sessions.registerRequiredExternalEvents(registration)
    expect(() => ctx.sessions.registerRequiredExternalEvents(registration)).toThrow('already registered')
    first()
    first()
    const replacement = ctx.sessions.registerRequiredExternalEvents(registration)
    replacement()

    const asynchronous: RequiredExternalSessionEventRegistration = {
      namespace: 'roundtable-async',
      version: 1,
      events: [{
        type: 'roundtable-async/run',
        validate: async (): Promise<void> => {
          throw new Error('asynchronous validator rejection')
        },
      }],
    }
    const asyncDispose = ctx.sessions.registerRequiredExternalEvents(asynchronous)
    const session = ctx.sessions.create(SessionId('external-async-validator'))
    expect(() => ctx.sessions.appendRequiredExternalEvent(session, 'roundtable-async/run', { runId: 'run-1' }))
      .toThrow('must complete synchronously')
    expect(ctx.sessions.requiredExternalEventValidation().validate(
      { namespace: 'roundtable-async', version: 1 },
      'roundtable-async/run',
      { runId: 'run-1' },
    )).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('must complete synchronously') })
    asyncDispose()
  })

  it('refuses a requiredExternal marker on a Harness event before a seeded session exists', () => {
    expect(() => Session.create(SessionId('external-first-party-seed'), [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
      requiredExternal: { namespace: 'roundtable-director', version: 1 },
    } as unknown as SessionEvent])).toThrow('cannot mark Harness event "turn/start" as requiredExternal')
  })

  it('allows an external seed only through SessionStore persistence preparation with an active registration', async () => {
    const id = SessionId('external-restored')
    const externalSeed = (): SessionEvent[] => [{
      type: 'roundtable-director/run',
      seq: 0,
      time: 1,
      data: { runId: 'run-1' },
      requiredExternal: { namespace: 'roundtable-director', version: 1 },
    } as unknown as SessionEvent]
    const header = () => ({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })

    expect(() => Session.create(id, externalSeed())).toThrow('requires an active SessionStore requiredExternal registration')
    expect(() => Session.fromRestore(id, externalSeed(), header(), SessionLogOffset(0)))
      .toThrow('requires an active SessionStore requiredExternal registration')

    const ctx = await setup()
    const dispose = ctx.sessions.registerRequiredExternalEvents(registration)
    expect(() => ctx.sessions.prepare(id, {
      seed: [{ ...externalSeed()[0]!, data: { runId: 'wrong' } }],
      meta: header(),
      inheritedEventCount: SessionLogOffset(0),
      seedSource: 'persistence',
    })).toThrow('run event requires runId "run-1"')
    const restored = ctx.sessions.prepare(id, {
      seed: externalSeed(),
      meta: header(),
      inheritedEventCount: SessionLogOffset(0),
      seedSource: 'persistence',
    })
    expect(restored.snapshotEvents()[0]).toMatchObject({
      type: 'roundtable-director/run',
      requiredExternal: { namespace: 'roundtable-director', version: 1 },
    })
    dispose()
  })
})
