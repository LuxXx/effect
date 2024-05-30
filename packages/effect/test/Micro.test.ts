import { Cause, Context, Duration, Effect, Either, Micro, Option, pipe } from "effect"
import { assert, describe, it } from "effect/test/utils/extend"

class ATag extends Context.Tag("ATag")<ATag, "A">() {}

describe("Micro", () => {
  it("runPromise", async () => {
    const result = await Micro.runPromise(Micro.succeed(1))
    assert.strictEqual(result, 1)
  })

  it("acquireUseRelease abort", async () => {
    let acquire = false
    let use = false
    let release = false
    const handle = Micro.acquireUseRelease(
      Micro.sync(() => {
        acquire = true
        return 123
      }).pipe(Micro.delay(100)),
      () =>
        Micro.sync(() => {
          use = true
        }),
      (_) =>
        Micro.sync(() => {
          assert.strictEqual(_, 123)
          release = true
        })
    ).pipe(Micro.runFork)
    handle.unsafeAbort()
    const result = await Micro.runPromise(handle.await)
    assert.deepStrictEqual(result, Either.left(Micro.FailureAborted))
    assert.isTrue(acquire)
    assert.isFalse(use)
    assert.isTrue(release)
  })

  it("acquireUseRelease uninterruptible", async () => {
    let acquire = false
    let use = false
    let release = false
    const handle = Micro.acquireUseRelease(
      Micro.sync(() => {
        acquire = true
        return 123
      }).pipe(Micro.delay(100)),
      (_) =>
        Micro.sync(() => {
          use = true
          return _
        }),
      (_) =>
        Micro.sync(() => {
          assert.strictEqual(_, 123)
          release = true
        })
    ).pipe(Micro.uninterruptible, Micro.runFork)
    handle.unsafeAbort()
    const result = await Micro.runPromise(handle.await)
    assert.deepStrictEqual(result, Either.right(123))
    assert.isTrue(acquire)
    assert.isTrue(use)
    assert.isTrue(release)
  })

  it("Context.Tag", () =>
    Micro.service(ATag).pipe(
      Micro.tap((_) => Micro.sync(() => assert.strictEqual(_, "A"))),
      Micro.provideService(ATag, "A"),
      Micro.runPromise
    ))

  it("Option", () =>
    Option.some("A").pipe(
      Micro.fromOption,
      Micro.tap((_) => assert.strictEqual(_, "A")),
      Micro.runPromise
    ))

  it("Either", () =>
    Either.right("A").pipe(
      Micro.fromEither,
      Micro.tap((_) => Micro.sync(() => assert.strictEqual(_, "A"))),
      Micro.runPromise
    ))

  it("gen", () =>
    Micro.gen(function*() {
      const result = yield* Micro.succeed(1)
      assert.strictEqual(result, 1)
      return result
    }).pipe(Micro.runPromise).then((_) => assert.deepStrictEqual(_, 1)))

  describe("forEach", () => {
    it("sequential", () =>
      Micro.gen(function*() {
        const results = yield* Micro.forEach([1, 2, 3], (_) => Micro.succeed(_))
        assert.deepStrictEqual(results, [1, 2, 3])
      }).pipe(Micro.runPromise))

    it("unbounded", () =>
      Micro.gen(function*() {
        const results = yield* Micro.forEach([1, 2, 3], (_) => Micro.succeed(_), { concurrency: "unbounded" })
        assert.deepStrictEqual(results, [1, 2, 3])
      }).pipe(Micro.runPromise))

    it("bounded", () =>
      Micro.gen(function*() {
        const results = yield* Micro.forEach([1, 2, 3, 4, 5], (_) => Micro.succeed(_), { concurrency: 2 })
        assert.deepStrictEqual(results, [1, 2, 3, 4, 5])
      }).pipe(Micro.runPromise))

    it("inherit unbounded", () =>
      Micro.gen(function*() {
        const handle = yield* Micro.forEach([1, 2, 3], (_) => Micro.succeed(_).pipe(Micro.delay(50)), {
          concurrency: "inherit"
        }).pipe(
          Micro.withConcurrency("unbounded"),
          Micro.fork
        )
        yield* Micro.sleep(55)
        assert.deepStrictEqual(handle.unsafePoll(), Either.right([1, 2, 3]))
      }).pipe(Micro.runPromise))

    it("sequential interrupt", () =>
      Micro.gen(function*() {
        const done: Array<number> = []
        const handle = yield* Micro.forEach([1, 2, 3, 4, 5, 6], (i) =>
          Micro.sync(() => {
            done.push(i)
            return i
          }).pipe(Micro.delay(50))).pipe(Micro.fork)
        yield* Micro.sleep(125)
        yield* handle.abort
        const result = yield* handle.await
        assert.deepStrictEqual(result, Either.left(Micro.FailureAborted))
        assert.deepStrictEqual(done, [1, 2])
      }).pipe(Micro.runPromise))

    it("unbounded interrupt", () =>
      Micro.gen(function*() {
        const done: Array<number> = []
        const handle = yield* Micro.forEach([1, 2, 3], (i) =>
          Micro.sync(() => {
            done.push(i)
            return i
          }).pipe(Micro.delay(50)), { concurrency: "unbounded" }).pipe(Micro.fork)
        yield* Micro.sleep(25)
        yield* handle.abort
        const result = yield* handle.await
        assert.deepStrictEqual(result, Either.left(Micro.FailureAborted))
        assert.deepStrictEqual(done, [])
      }).pipe(Micro.runPromise))

    it("bounded interrupt", () =>
      Micro.gen(function*() {
        const done: Array<number> = []
        const handle = yield* Micro.forEach([1, 2, 3, 4, 5, 6], (i) =>
          Micro.sync(() => {
            done.push(i)
            return i
          }).pipe(Micro.delay(50)), { concurrency: 2 }).pipe(Micro.fork)
        yield* Micro.sleep(75)
        yield* handle.abort
        const result = yield* handle.await
        assert.deepStrictEqual(result, Either.left(Micro.FailureAborted))
        assert.deepStrictEqual(done, [1, 2])
      }).pipe(Micro.runPromise))

    it("unbounded fail", () =>
      Micro.gen(function*() {
        const done: Array<number> = []
        const handle = yield* Micro.forEach([1, 2, 3, 4, 5], (i) =>
          Micro.suspend(() => {
            done.push(i)
            return i === 3 ? Micro.fail("error") : Micro.succeed(i)
          }).pipe(Micro.delay(i * 10)), {
          concurrency: "unbounded"
        }).pipe(Micro.fork)
        const result = yield* handle.await
        assert.deepStrictEqual(result, Either.left(Micro.FailureExpected("error")))
        assert.deepStrictEqual(done, [1, 2, 3])
      }).pipe(Micro.runPromise))
  })

  describe("acquireRelease", () => {
    it("releases on abort", () =>
      Micro.gen(function*() {
        let release = false
        const handle = yield* Micro.acquireRelease(
          Micro.delay(Micro.succeed("foo"), 100),
          () =>
            Micro.sync(() => {
              release = true
            })
        ).pipe(Micro.scoped, Micro.fork)
        handle.unsafeAbort()
        yield* handle.await
        assert.strictEqual(release, true)
      }).pipe(Micro.runPromise))
  })

  it("raceAll", () =>
    Micro.gen(function*() {
      const interrupted: Array<number> = []
      const result = yield* Micro.raceAll([100, 75, 50, 0, 25].map((ms) =>
        (ms === 0 ? Micro.fail("boom") : Micro.succeed(ms)).pipe(
          Micro.delay(ms),
          Micro.onInterrupt(() =>
            Micro.sync(() => {
              interrupted.push(ms)
            })
          )
        )
      ))
      assert.strictEqual(result, 25)
      assert.deepStrictEqual(interrupted, [100, 75, 50])
    }).pipe(Micro.runPromise))

  it("raceAllFirst", () =>
    Micro.gen(function*() {
      const interrupted: Array<number> = []
      const result = yield* Micro.raceAllFirst([100, 75, 50, 0, 25].map((ms) =>
        (ms === 0 ? Micro.fail("boom") : Micro.succeed(ms)).pipe(
          Micro.delay(ms),
          Micro.onInterrupt(() =>
            Micro.sync(() => {
              interrupted.push(ms)
            })
          )
        )
      )).pipe(Micro.asResult)
      assert.deepStrictEqual(result, Either.left(Micro.FailureExpected("boom")))
      assert.deepStrictEqual(interrupted, [100, 75, 50, 25])
    }).pipe(Micro.runPromise))

  describe("valid Effect", () => {
    it.effect("success", () =>
      Effect.gen(function*(_) {
        const result = yield* Micro.succeed(123)
        assert.strictEqual(result, 123)
      }))

    it.effect("failure", () =>
      Effect.gen(function*(_) {
        const result = yield* Micro.fail("boom").pipe(
          Effect.sandbox,
          Effect.flip
        )
        assert.deepStrictEqual(result, Cause.fail("boom"))
      }))

    it.effect("defects", () =>
      Effect.gen(function*(_) {
        const result = yield* Micro.die("boom").pipe(
          Effect.sandbox,
          Effect.flip
        )
        assert.deepStrictEqual(result, Cause.die("boom"))
      }))

    it.effect("context", () =>
      Effect.gen(function*(_) {
        const result = yield* ATag.pipe(
          Micro.service,
          Micro.map((_) => _)
        )
        assert.deepStrictEqual(result, "A")
      }).pipe(Effect.provideService(ATag, "A")))
  })

  describe("repeat", () => {
    it.live("is stack safe", () =>
      Micro.void.pipe(
        Micro.repeat({ times: 10000 })
      ))

    it.live("is interruptible", () =>
      Micro.void.pipe(
        Micro.forever,
        Micro.timeout(50)
      ))

    it("works with runSync", () => {
      const result = Micro.succeed(123).pipe(
        Micro.repeat({ times: 1000 }),
        Micro.runSync
      )
      assert.deepStrictEqual(result, 123)
    })
  })

  describe("timeout", () => {
    it.live("timeout a long computation", () =>
      Micro.gen(function*() {
        const result = yield* pipe(
          Micro.sleep(Duration.seconds(60)),
          Micro.andThen(Micro.succeed(true)),
          Micro.timeout(10)
        )
        assert.deepStrictEqual(result, Option.none())
      }))
    it.live("timeout a long computation with a failure", () =>
      Effect.gen(function*() {
        const error = new Error("boom")
        const result = yield* pipe(
          Micro.sleep(Duration.seconds(5)),
          Micro.andThen(Micro.succeed(true)),
          Micro.timeoutOrElse({
            onTimeout: () => Micro.die(error),
            duration: Duration.millis(10)
          }),
          Micro.sandbox,
          Micro.flip
        )
        assert.deepStrictEqual(result, Micro.FailureUnexpected(error))
      }))
    it.live("timeout repetition of uninterruptible effect", () =>
      Micro.gen(function*() {
        const result = yield* pipe(
          Micro.void,
          Micro.uninterruptible,
          Micro.forever,
          Micro.timeout(Duration.millis(10))
        )
        assert.deepStrictEqual(result, Option.none())
      }))
    it.live("timeout in uninterruptible region", () =>
      Effect.gen(function*($) {
        const result = yield* $(Effect.void, Effect.timeout(Duration.seconds(20)), Effect.uninterruptible)
        assert.deepStrictEqual(result, void 0)
      }))
  })
})
