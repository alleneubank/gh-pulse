import { describe, expect, it } from 'bun:test'
import { RequestTimeoutError, withTimeout } from './github'

describe('withTimeout', () => {
  it('returns the resolved value when work finishes before the timeout', async () => {
    const result = await withTimeout(async () => 42, 1000)
    expect(result).toBe(42)
  })

  it('rejects with RequestTimeoutError when work never settles', async () => {
    // A connected-but-silent socket never settles; the hard timeout must still fire.
    const promise = withTimeout<never>(() => new Promise<never>(() => {}), 20)
    await expect(promise).rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('aborts the supplied signal when the timeout fires', async () => {
    let capturedSignal: AbortSignal | undefined
    const promise = withTimeout<never>((signal) => {
      capturedSignal = signal
      return new Promise<never>(() => {})
    }, 20)
    await expect(promise).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('propagates the underlying error instead of a timeout when work rejects first', async () => {
    const promise = withTimeout(async () => {
      throw new Error('boom')
    }, 1000)
    await expect(promise).rejects.toThrow('boom')
  })

  it('does not reject with a timeout after work already rejected', async () => {
    // A late rejection from the abandoned work must not surface as an unhandled rejection.
    const promise = withTimeout<never>(
      () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('late')), 5)
        }),
      1000,
    )
    await expect(promise).rejects.toThrow('late')
  })
})
