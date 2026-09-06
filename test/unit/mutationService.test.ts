import { expect } from "chai";
import { MutationService } from "../../src/services/mutationService";
import { FakeGateway } from "./fakeGateway";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("mutationService", function () {
  let gateway: FakeGateway;

  beforeEach(function () {
    gateway = new FakeGateway();
  });

  it("serializes concurrent operations instead of interleaving them", async function () {
    const service = new MutationService(gateway);
    const order: string[] = [];
    const first = deferred<void>();

    const a = service.enqueue("a", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });

    const b = service.enqueue("b", async () => {
      order.push("b:start");
      order.push("b:end");
    });

    // Queued work starts on a microtask, so let the queue spin up first.
    await flush();

    // b must not have started while a is still in flight.
    expect(order).to.deep.equal(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);

    expect(order).to.deep.equal(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps draining after an operation rejects", async function () {
    const service = new MutationService(gateway);

    const failed = service.enqueue("boom", async () => {
      throw new Error("boom");
    });
    await failed.then(
      () => expect.fail("expected rejection"),
      (e: Error) => expect(e.message).to.equal("boom"),
    );

    const result = await service.enqueue("ok", async () => "done");
    expect(result).to.equal("done");
  });

  it("times out a stuck operation with an actionable message", async function () {
    const service = new MutationService(gateway, 20);

    let error: any;
    try {
      await service.enqueue("stuck", () => new Promise(() => {}));
    } catch (e) {
      error = e;
    }

    expect(error?.code).to.equal("timeout");
    expect(error.message).to.include("stuck");
    expect(error.message).to.include("20 ms");
  });

  it("tracks pending depth", async function () {
    const service = new MutationService(gateway);
    const gate = deferred<void>();

    const running = service.enqueue("slow", async () => {
      await gate.promise;
    });
    expect(service.pending).to.equal(1);

    gate.resolve();
    await running;
    expect(service.pending).to.equal(0);
  });

  it("runs transactional work through the gateway transaction", async function () {
    const service = new MutationService(gateway);

    const value = await service.enqueueTransaction("tx", async () => 42);

    expect(value).to.equal(42);
    expect(gateway.transactionCount).to.equal(1);
  });

  it("propagates a transaction commit failure to the caller", async function () {
    const service = new MutationService(gateway);
    gateway.failTransactionCommit = true;

    let error: any;
    try {
      await service.enqueueTransaction("tx", async () => "written");
    } catch (e) {
      error = e;
    }

    expect(error?.message).to.equal("simulated commit failure");
  });
});
